'use strict';

const { createPublicKey, randomUUID, createHash, verify: verifySignature } = require('crypto');
const { query } = require('./db.cjs');

const ERR = (code, message) => ({ error: { code, message } });
const CLOCK_TOLERANCE_SEC = 60;
const JWKS_CACHE_MS = 10 * 60 * 1000;
let jwksCache = { fetchedAt: 0, keys: [] };

function getIssuerBaseUrl() {
  const raw = process.env.AUTH0_ISSUER_BASE_URL || (process.env.AUTH0_DOMAIN ? `https://${process.env.AUTH0_DOMAIN}` : '');
  return raw ? raw.replace(/\/+$/, '') : '';
}

function getAudience() {
  return process.env.AUTH0_AUDIENCE || '';
}

function isAuthConfigured() {
  return Boolean(getIssuerBaseUrl() && getAudience());
}

function base64UrlDecode(input) {
  const normalized = String(input || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
  return Buffer.from(padded, 'base64');
}

function decodeJson(input) {
  return JSON.parse(base64UrlDecode(input).toString('utf8'));
}

function parseJwt(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('invalid JWT format');
  return { header: decodeJson(parts[0]), payload: decodeJson(parts[1]), signingInput: `${parts[0]}.${parts[1]}`, signature: base64UrlDecode(parts[2]) };
}

async function fetchJwks() {
  const now = Date.now();
  if (jwksCache.keys.length && now - jwksCache.fetchedAt < JWKS_CACHE_MS) return jwksCache.keys;
  const issuer = getIssuerBaseUrl();
  const res = await fetch(`${issuer}/.well-known/jwks.json`);
  if (!res.ok) throw new Error(`failed to fetch Auth0 JWKS: HTTP ${res.status}`);
  const body = await res.json();
  jwksCache = { fetchedAt: now, keys: Array.isArray(body.keys) ? body.keys : [] };
  return jwksCache.keys;
}

function assertClaims(payload) {
  const issuer = `${getIssuerBaseUrl()}/`;
  const audience = getAudience();
  const nowSec = Math.floor(Date.now() / 1000);
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (payload.iss !== issuer) throw new Error('invalid token issuer');
  if (!audiences.includes(audience)) throw new Error('invalid token audience');
  if (!payload.sub) throw new Error('missing token subject');
  if (payload.exp && Number(payload.exp) + CLOCK_TOLERANCE_SEC < nowSec) throw new Error('token expired');
  if (payload.nbf && Number(payload.nbf) - CLOCK_TOLERANCE_SEC > nowSec) throw new Error('token not active');
}

async function verifyAuth0Token(token) {
  const jwt = parseJwt(token);
  if (jwt.header.alg !== 'RS256') throw new Error('unsupported token algorithm');
  const keys = await fetchJwks();
  const jwk = keys.find((key) => key.kid === jwt.header.kid && key.kty === 'RSA');
  if (!jwk) throw new Error('matching Auth0 signing key not found');
  const publicKey = createPublicKey({ key: jwk, format: 'jwk' });
  const ok = verifySignature('RSA-SHA256', Buffer.from(jwt.signingInput), publicKey, jwt.signature);
  if (!ok) throw new Error('invalid token signature');
  assertClaims(jwt.payload);
  return jwt.payload;
}

function configuredLegacyOwnerEmails() {
  return String(process.env.KEYGATE_LEGACY_OWNER_EMAILS || process.env.INITIAL_OWNER_EMAIL || process.env.ADMIN_EMAIL || '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

function canClaimLegacyData(user) {
  const email = String(user?.email || '').trim().toLowerCase();
  return Boolean(email && configuredLegacyOwnerEmails().includes(email));
}

function slugify(value) {
  const base = String(value || 'workspace').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'workspace';
  return `${base}-${createHash('sha1').update(`${value}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 6)}`;
}

async function syncAuthUser(claims) {
  const auth0Sub = String(claims.sub);
  const email = claims.email || null;
  const name = claims.name || claims.nickname || email || 'Lethem User';
  const pictureUrl = claims.picture || null;
  const { rows } = await query(
    `INSERT INTO users (id, auth0_sub, email, name, picture_url, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (auth0_sub) DO UPDATE SET email = EXCLUDED.email, name = COALESCE(NULLIF(users.name, ''), EXCLUDED.name), picture_url = EXCLUDED.picture_url, updated_at = NOW()
     RETURNING id, auth0_sub, email, name, picture_url`,
    [randomUUID(), auth0Sub, email, name, pictureUrl],
  );
  return rows[0];
}

async function acceptPendingInvites(user) {
  const email = String(user?.email || '').trim().toLowerCase();
  if (!email) return;
  const { rows } = await query(
    `SELECT id, organization_id, role
     FROM organization_invites
     WHERE LOWER(email) = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()`,
    [email],
  );
  for (const invite of rows) {
    await query('BEGIN');
    try {
      await query(
        `INSERT INTO organization_members (organization_id, user_id, role, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role, updated_at = NOW()`,
        [invite.organization_id, user.id, normalizeOrgRole(invite.role)],
      );
      await query(
        `UPDATE organization_invites SET accepted_at = NOW(), accepted_by_user_id = $1, invited_user_id = COALESCE(invited_user_id, $1), updated_at = NOW() WHERE id = $2`,
        [user.id, invite.id],
      );
      await query('COMMIT');
    } catch (err) {
      await query('ROLLBACK').catch(() => {});
      throw err;
    }
  }
}

function normalizeOrgRole(role) {
  const value = String(role || '').toLowerCase();
  if (value === 'member') return 'developer';
  return ['owner', 'admin', 'developer', 'viewer'].includes(value) ? value : 'viewer';
}

const ROLE_RANK = { viewer: 1, developer: 2, member: 2, admin: 3, owner: 4 };
function roleAtLeast(role, minimum) {
  return (ROLE_RANK[normalizeOrgRole(role)] || 0) >= (ROLE_RANK[normalizeOrgRole(minimum)] || 0);
}

async function ensureDefaultOrganization(user) {
  await acceptPendingInvites(user);
  const { rows: existing } = await query(
    `SELECT o.id, o.name, o.slug, om.role
     FROM organizations o
     JOIN organization_members om ON om.organization_id = o.id
     WHERE om.user_id = $1
     ORDER BY o.created_at ASC
     LIMIT 1`,
    [user.id],
  );
  if (existing[0]) return existing[0];

  const organizationId = randomUUID();
  const organizationName = user.email ? `${String(user.email).split('@')[0]}'s Workspace` : 'My Workspace';
  const organizationSlug = slugify(organizationName);
  await query('BEGIN');
  try {
    const { rows } = await query(
      `INSERT INTO organizations (id, name, slug, owner_user_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, slug, plan, subscription_status, razorpay_subscription_id`,
      [organizationId, organizationName, organizationSlug, user.id],
    );
    await query(
      `INSERT INTO organization_members (organization_id, user_id, role)
       VALUES ($1, $2, 'owner')
       ON CONFLICT (organization_id, user_id) DO NOTHING`,
      [organizationId, user.id],
    );
    if (canClaimLegacyData(user)) {
      await query('UPDATE projects SET organization_id = $1 WHERE organization_id IS NULL', [organizationId]);
    }
    await query('COMMIT');
    return { ...rows[0], role: 'owner' };
  } catch (err) {
    await query('ROLLBACK').catch(() => {});
    throw err;
  }
}

async function loadUserOrganizations(userId) {
  const { rows } = await query(
    `SELECT o.id, o.name, o.slug, o.plan, o.subscription_status, o.razorpay_subscription_id, om.role, EXTRACT(EPOCH FROM o.created_at)::bigint AS created_at
     FROM organizations o
     JOIN organization_members om ON om.organization_id = o.id
     WHERE om.user_id = $1
     ORDER BY o.created_at ASC`,
    [userId],
  );
  return rows;
}

async function authenticateRequest(req, reply) {
  if (!isAuthConfigured()) {
    return reply.code(500).send(ERR('AUTH_NOT_CONFIGURED', 'Auth0 is not configured on this server.'));
  }
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!bearer) return reply.code(401).send(ERR('MISSING_AUTHORIZATION', 'Missing Auth0 Authorization header.'));
  try {
    const claims = await verifyAuth0Token(bearer);
    const user = await syncAuthUser(claims);
    const organization = await ensureDefaultOrganization(user);
    req.auth = { claims, user, organization };
    return req.auth;
  } catch (err) {
    req.log.warn({ err: err.message }, 'Auth0 token rejected');
    return reply.code(401).send(ERR('INVALID_AUTH_TOKEN', 'Invalid or expired Auth0 token.'));
  }
}

async function requireAuth(req, reply) {
  if (req.auth?.user) return req.auth;
  return authenticateRequest(req, reply);
}

async function requireOrgRole(req, reply, roles = []) {
  const auth = await requireAuth(req, reply);
  if (!auth) return null;
  const role = normalizeOrgRole(auth.organization?.role || 'viewer');
  const allowed = roles.map(normalizeOrgRole);
  if (allowed.length && !allowed.includes(role)) {
    reply.code(403).send(ERR('FORBIDDEN', 'Your organization role does not allow this action.'));
    return null;
  }
  return auth;
}

module.exports = {
  requireAuth,
  requireOrgRole,
  loadUserOrganizations,
  normalizeOrgRole,
  roleAtLeast,
};
