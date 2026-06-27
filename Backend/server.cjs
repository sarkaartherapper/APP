'use strict';

require('dotenv').config();
const { randomUUID, createHash, createHmac } = require('crypto');
const fastify = require('fastify')({ logger: { level: 'info' }, genReqId: () => randomUUID() });
const { createClient } = require('redis');
const { query, initDb, encryptSecret, decryptSecret } = require('./db.cjs');
const { requireAuth, requireOrgRole, loadUserOrganizations, normalizeOrgRole } = require('./auth.cjs');
const { BILLING_PLANS, publicBillingConfig } = require('./billing.cjs');
const { sendEmail } = require('./email.cjs');
const { listProviders, listModels, getProvider, getProviderForModel, getDefaultModel, isModelAllowedForProvider, normalizeAllowedModels, normalizeProviderModel, normalizeUsage, estimateCostUsd, callProvider, normalizeProviderResponse } = require('./providers.cjs');

const DEFAULT_RPM_LIMIT = Number(process.env.RATE_LIMIT_DEFAULT_PER_MIN || 2);
const redis = createClient({
  url: process.env.REDIS_URL,
  socket: {
    reconnectStrategy: (retries) => Math.min(retries * 100, 3000),
  },
});
redis.on('error', (err) => {
  fastify.log.warn({ err }, 'redis client error');
});
redis.on('reconnecting', () => {
  fastify.log.warn('redis reconnecting');
});
redis.on('ready', () => {
  fastify.log.info('redis connection ready');
});
const ERR = (code, message) => ({ error: { code, message } });
const isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(v || ''));

fastify.register(require('@fastify/cors'), {
  origin: true,
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-lethem-client', 'x-keygate-client', 'x-project-id'],
});
fastify.register(require('@fastify/helmet'), { contentSecurityPolicy: false });

function hashToken(token) { return createHash('sha256').update(token).digest('hex'); }

function publicAppUrl() {
  const fallback = 'https://lethem.vercel.app';
  const raw = String(process.env.FRONTEND_URL || process.env.PUBLIC_APP_URL || process.env.APP_BASE_URL || fallback).trim();
  const normalized = (raw || fallback).replace(/\/+$/, '');
  try {
    const host = new URL(normalized).hostname.toLowerCase();
    if (host.includes('lethem-backend') || host.endsWith('.onrender.com')) return fallback;
  } catch (_) { return fallback; }
  return normalized;
}

function inviteLink(token) {
  return `${publicAppUrl()}/invite/${encodeURIComponent(token)}`;
}

function inviteEmailContent({ role, organizationName, inviterName, token }) {
  const link = inviteLink(token);
  const safeOrg = organizationName || 'their workspace';
  const safeInviter = inviterName || 'A teammate';
  return {
    subject: `${safeInviter} invited you to ${organizationName || 'Lethem'}`,
    html: `<div style="font-family:Inter,Arial,sans-serif;line-height:1.5;color:#111827"><h2>You're invited to Lethem</h2><p>${safeInviter} invited you to join <strong>${safeOrg}</strong> as <strong>${role}</strong>.</p><p><a href="${link}" style="display:inline-block;background:#7c6bff;color:#fff;padding:10px 14px;border-radius:8px;text-decoration:none">Accept invite</a></p><p>If the button does not work, copy this link:<br/><a href="${link}">${link}</a></p></div>`,
    text: `You're invited to Lethem. ${safeInviter} invited you to join ${safeOrg} as ${role}. Accept invite: ${link}`,
  };
}

function isEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim()); }

async function findUserByEmail(email) {
  const { rows } = await query(
    `SELECT id, email, name, picture_url FROM users WHERE LOWER(email) = $1 ORDER BY updated_at DESC LIMIT 1`,
    [String(email || '').trim().toLowerCase()],
  );
  return rows[0] || null;
}

async function acceptInviteForUser({ inviteId = null, token = null, user }) {
  const params = [];
  let where = '';
  if (token) { params.push(hashToken(String(token))); where = 'oi.token_hash = $1'; }
  else { params.push(String(inviteId || '')); where = 'oi.id = $1'; }
  const { rows } = await query(
    `SELECT oi.id, oi.organization_id, oi.role, oi.email, oi.invited_user_id
     FROM organization_invites oi
     WHERE ${where} AND oi.accepted_at IS NULL AND oi.revoked_at IS NULL AND oi.expires_at > NOW()
     LIMIT 1`,
    params,
  );
  const invite = rows[0];
  if (!invite) return { error: 'INVITE_NOT_FOUND' };
  const userEmail = String(user?.email || '').toLowerCase();
  const invitedEmail = String(invite.email || '').toLowerCase();
  const invitedUserMatches = invite.invited_user_id && String(invite.invited_user_id) === String(user.id);
  if (!invitedUserMatches && invitedEmail !== userEmail) return { error: 'INVITE_EMAIL_MISMATCH' };
  await query('BEGIN');
  try {
    await query(
      `INSERT INTO organization_members (organization_id, user_id, role, updated_at)
       VALUES ($1,$2,$3,NOW())
       ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role, updated_at = NOW()`,
      [invite.organization_id, user.id, normalizeOrgRole(invite.role)],
    );
    await query(
      `UPDATE organization_invites SET accepted_at = NOW(), accepted_by_user_id = $1, invited_user_id = COALESCE(invited_user_id, $1), updated_at = NOW() WHERE id = $2`,
      [user.id, invite.id],
    );
    await query('COMMIT');
  } catch (err) { await query('ROLLBACK').catch(() => {}); throw err; }
  return { invite };
}

function maskKey(apiKey) { return apiKey.slice(0, 7) + '••••••••' + apiKey.slice(-4); }

async function pingRedis() {
  if (!redis.isReady) throw new Error('redis connection is not ready');
  return redis.ping();
}

async function incrementRedisWindow(key, ttlSec) {
  if (!redis.isReady) return null;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, ttlSec);
  return count;
}

async function insertRequestLog({ req, subkey = {}, model = null, tokensUsed = 0, promptTokens = 0, completionTokens = 0, status, errorReason = null, source, latencyMs, estimatedCostUsd = 0 }) {
  const id = randomUUID();
  const provider = subkey.provider || null;
  await query(
    `INSERT INTO request_logs (id,request_id,project_id,subkey_id,subkey_name,provider,model,tokens_used,prompt_tokens,completion_tokens,estimated_cost_usd,status,error_reason,source,latency_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [id, req.id, subkey.project_id, subkey.id || null, subkey.name || null, provider, model, tokensUsed, promptTokens, completionTokens, estimatedCostUsd, status, errorReason, source || req.headers['x-lethem-client'] || req.headers['x-keygate-client'] || 'external', latencyMs],
  );
  req.log.info({
    event: 'gateway_request_log',
    log_id: id,
    provider,
    model,
    status,
    error_reason: errorReason,
    tokens_used: tokensUsed,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    estimated_cost_usd: estimatedCostUsd,
    latency_ms: latencyMs,
    subkey_id: subkey.id || null,
    project_id: subkey.project_id || null,
  }, 'gateway request logged');
}

async function rateLimitBySubkey(subkeyId, limit = DEFAULT_RPM_LIMIT) {
  const nowSec = Math.floor(Date.now() / 1000);
  const windowSec = 60;
  const windowStart = Math.floor(nowSec / windowSec) * windowSec;
  const redisKey = `rl:subkey:${subkeyId}:${windowStart}`;
  let count = 0;
  try {
    count = await incrementRedisWindow(redisKey, windowSec);
  } catch (err) {
    fastify.log.warn({ err, subkeyId }, 'redis rate limit check failed; allowing request');
    count = null;
  }
  const reset = windowStart + windowSec;
  if (count === null) return { remaining: limit, reset, limit, allowed: true };
  const remaining = Math.max(limit - count, 0);
  return { remaining, reset, limit, allowed: count <= limit };
}

fastify.addHook('onRequest', async (req) => {
  req._startedAt = Date.now();
});
fastify.addHook('onResponse', async (req, reply) => {
  const ms = Date.now() - (req._startedAt || Date.now());
  req.log.info({ method: req.method, path: req.url, status: reply.statusCode, ms }, 'request metrics');
});

fastify.setErrorHandler(async (err, req, reply) => {
  req.log.error({ err }, 'request failed');
  try {
    await query(
      `INSERT INTO app_error_logs (id,request_id,method,path,message,stack) VALUES ($1,$2,$3,$4,$5,$6)`,
      [randomUUID(), req.id || null, req.method, req.url, String(err.message || err), String(err.stack || '')],
    );
  } catch (_) {}
  return reply.code(err.statusCode || 500).send(ERR('INTERNAL_ERROR', err.message || 'internal error'));
});

fastify.get('/health', async () => ({ status: 'ok', ts: Date.now(), request_id: randomUUID() }));

fastify.get('/invite/:token', async (req, reply) => {
  return reply.redirect(302, inviteLink(req.params.token));
});

fastify.get('/health/db', async (req, reply) => {
  try {
    await query('SELECT 1');
    return { ok: true };
  } catch (e) {
    return reply.code(500).send(ERR('DB_UNHEALTHY', e.message || 'db unavailable'));
  }
});

fastify.get('/health/redis', async (req, reply) => {
  try {
    await pingRedis();
    return { ok: true };
  } catch (e) {
    return reply.code(500).send(ERR('REDIS_UNHEALTHY', e.message || 'redis unavailable'));
  }
});

fastify.get('/api/health', async () => {
  const { rows } = await query(`SELECT day, internal_ok, db_ok, redis_ok, details FROM health_daily ORDER BY day DESC LIMIT 90`);
  return rows.reverse();
});

fastify.post('/api/health/refresh-now', async (req, reply) => {
  const auth = await requireOrgRole(req, reply, ['owner', 'admin']); if (!auth) return;
  try {
    let db_ok = false; let redis_ok = false;
    try { await query('SELECT 1'); db_ok = true; } catch (_) {}
    try { await pingRedis(); redis_ok = true; } catch (_) {}
    const internal_ok = db_ok && redis_ok;
    await query(
      `INSERT INTO health_daily (day, internal_ok, db_ok, redis_ok, details, updated_at)
       VALUES (CURRENT_DATE, $1, $2, $3, $4::jsonb, NOW())
       ON CONFLICT (day) DO UPDATE SET internal_ok=EXCLUDED.internal_ok, db_ok=EXCLUDED.db_ok, redis_ok=EXCLUDED.redis_ok, details=EXCLUDED.details, updated_at=NOW()`,
      [internal_ok, db_ok, redis_ok, JSON.stringify({ refreshed_manually: true, checked_at: Date.now() })],
    );
    return { success: true, internal_ok, db_ok, redis_ok };
  } catch (e) {
    return reply.code(500).send(ERR('HEALTH_REFRESH_FAILED', e.message || 'health refresh failed'));
  }
});

fastify.get('/api/admin/error-logs', async (req, reply) => {
  const auth = await requireOrgRole(req, reply, ['owner', 'admin']); if (!auth) return;
  const limitRaw = Number(req.query?.limit || 100);
  const limit = Math.max(1, Math.min(500, Number.isFinite(limitRaw) ? Math.round(limitRaw) : 100));
  const before = req.query?.before ? Number(req.query.before) : null;
  if (before && Number.isFinite(before)) {
    const { rows } = await query(
      `SELECT id,request_id,method,path,message,EXTRACT(EPOCH FROM created_at)::bigint AS created_at
       FROM app_error_logs
       WHERE EXTRACT(EPOCH FROM created_at)::bigint < $1
       ORDER BY created_at DESC LIMIT $2`,
      [before, limit],
    );
    return rows;
  }
  const { rows } = await query(
    `SELECT id,request_id,method,path,message,EXTRACT(EPOCH FROM created_at)::bigint AS created_at
     FROM app_error_logs ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  return rows;
});



function billingPlanById(planId) {
  return BILLING_PLANS.find((plan) => plan.id === String(planId || '').toLowerCase());
}

function getPlanProjectLimit(planId) {
  const plan = billingPlanById(planId) || billingPlanById('free');
  return plan?.limits?.projects ?? 999999;
}

function requireRazorpayConfig(reply) {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    reply.code(503).send(ERR('RAZORPAY_NOT_CONFIGURED', 'Razorpay keys are not configured on the server'));
    return null;
  }
  return { keyId, keySecret };
}

async function razorpayRequest(path, method = 'GET', body = null) {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  const res = await fetch(`https://api.razorpay.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.description || data?.error?.reason || `Razorpay HTTP ${res.status}`);
  return data;
}

fastify.get('/api/billing/plans', async (req, reply) => {
  const auth = await requireAuth(req, reply); if (!auth) return;
  return { ...publicBillingConfig(), currentPlan: auth.organization.plan || 'free', subscriptionStatus: auth.organization.subscription_status || 'free', subscriptionId: auth.organization.razorpay_subscription_id || null };
});

fastify.post('/api/billing/subscriptions', async (req, reply) => {
  const auth = await requireOrgRole(req, reply, ['owner', 'admin']); if (!auth) return;
  const cfg = requireRazorpayConfig(reply); if (!cfg) return;
  const plan = billingPlanById(req.body?.planId);
  if (!plan || plan.id === 'free' || !plan.razorpayPlanId) return reply.code(400).send(ERR('INVALID_PLAN', 'Select a paid Razorpay plan'));
  const customerNotify = Boolean(req.body?.customerNotify ?? false);
  const notes = { app: 'lethem', organization_id: auth.organization.id, organization_slug: auth.organization.slug, plan: plan.id };
  const subscription = await razorpayRequest('/subscriptions', 'POST', {
    plan_id: plan.razorpayPlanId,
    total_count: 120,
    quantity: 1,
    customer_notify: customerNotify ? 1 : 0,
    notes,
  });
  await query(
    `UPDATE organizations SET plan = $1, razorpay_subscription_id = $2, subscription_status = $3, updated_at = NOW() WHERE id = $4`,
    [plan.id, subscription.id, subscription.status || 'created', auth.organization.id],
  );
  await query(
    `INSERT INTO billing_events (id,organization_id,event_type,razorpay_subscription_id,payload) VALUES ($1,$2,$3,$4,$5::jsonb)`,
    [randomUUID(), auth.organization.id, 'subscription_created', subscription.id, JSON.stringify(subscription)],
  );
  return { subscriptionId: subscription.id, status: subscription.status, planId: plan.id, keyId: cfg.keyId, currency: 'INR' };
});

fastify.post('/api/billing/verify', async (req, reply) => {
  const auth = await requireOrgRole(req, reply, ['owner', 'admin']); if (!auth) return;
  const cfg = requireRazorpayConfig(reply); if (!cfg) return;
  const { razorpay_payment_id, razorpay_subscription_id, razorpay_signature, planId } = req.body || {};
  if (!razorpay_payment_id || !razorpay_subscription_id || !razorpay_signature) return reply.code(400).send(ERR('MISSING_PAYMENT_FIELDS', 'Missing Razorpay payment verification fields'));
  const expected = createHmac('sha256', cfg.keySecret).update(`${razorpay_payment_id}|${razorpay_subscription_id}`).digest('hex');
  if (expected !== razorpay_signature) return reply.code(400).send(ERR('INVALID_SIGNATURE', 'Razorpay payment signature is invalid'));
  const plan = billingPlanById(planId) || billingPlanById('pro');
  await query(
    `UPDATE organizations SET plan = $1, razorpay_subscription_id = $2, subscription_status = 'active', updated_at = NOW() WHERE id = $3`,
    [plan.id, razorpay_subscription_id, auth.organization.id],
  );
  await query(
    `INSERT INTO billing_events (id,organization_id,event_type,razorpay_subscription_id,razorpay_payment_id,payload) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
    [randomUUID(), auth.organization.id, 'payment_verified', razorpay_subscription_id, razorpay_payment_id, JSON.stringify(req.body)],
  );
  return { success: true, planId: plan.id, status: 'active' };
});

fastify.get('/api/me', async (req, reply) => {
  const auth = await requireAuth(req, reply); if (!auth) return;
  const organizations = await loadUserOrganizations(auth.user.id);
  return { user: auth.user, organization: auth.organization, organizations };
});

fastify.patch('/api/me', {
  schema: { body: { type: 'object', properties: { name: { type: 'string' }, workspaceName: { type: 'string' } } } },
}, async (req, reply) => {
  const auth = await requireOrgRole(req, reply, ['owner', 'admin']); if (!auth) return;
  const body = req.body || {};
  const hasName = Object.prototype.hasOwnProperty.call(body, 'name');
  const hasWorkspaceName = Object.prototype.hasOwnProperty.call(body, 'workspaceName');
  const name = hasName ? String(body.name || '').trim() : auth.user.name;
  const workspaceName = hasWorkspaceName ? String(body.workspaceName || '').trim() : auth.organization.name;
  if (hasName && !name) return reply.code(400).send(ERR('VALIDATION_ERROR', 'name required'));
  if (hasWorkspaceName && !workspaceName) return reply.code(400).send(ERR('VALIDATION_ERROR', 'workspace name required'));
  if (!hasName && !hasWorkspaceName) return reply.code(400).send(ERR('VALIDATION_ERROR', 'nothing to update'));

  const { rows: userRows } = hasName
    ? await query(
      `UPDATE users SET name = $1, updated_at = NOW() WHERE id = $2 RETURNING id, auth0_sub, email, name, picture_url`,
      [name, auth.user.id],
    )
    : await query(`SELECT id, auth0_sub, email, name, picture_url FROM users WHERE id = $1`, [auth.user.id]);
  const { rows: orgRows } = hasWorkspaceName
    ? await query(
      `UPDATE organizations SET name = $1, updated_at = NOW() WHERE id = $2 RETURNING id, name, slug, plan, subscription_status, razorpay_subscription_id`,
      [workspaceName, auth.organization.id],
    )
    : await query(`SELECT id, name, slug, plan, subscription_status, razorpay_subscription_id FROM organizations WHERE id = $1`, [auth.organization.id]);
  return { user: userRows[0], organization: { ...orgRows[0], role: auth.organization.role } };
});

async function getProject(req, reply) {
  const auth = await requireAuth(req, reply); if (!auth) return null;
  const projectRef = String(req.headers['x-project-id'] || '').trim();
  if (!projectRef) {
    reply.code(400).send(ERR('MISSING_PROJECT_HEADER', 'Missing x-project-id header'));
    return null;
  }
  const { rows } = await query(
    `SELECT p.id,p.name,p.slug,p.status,p.organization_id,om.role AS organization_role
     FROM projects p
     JOIN organization_members om ON om.organization_id = p.organization_id AND om.user_id = $2
     WHERE (p.id::text = $1 OR p.slug = $1)
     LIMIT 1`,
    [projectRef, auth.user.id],
  );
  const project = rows[0];
  if (!project) {
    reply.code(404).send(ERR('PROJECT_NOT_FOUND', 'project not found'));
    return null;
  }
  if (project.status !== 'active') {
    reply.code(403).send(ERR('PROJECT_INACTIVE', 'project is not active'));
    return null;
  }
  req.projectRole = project.organization_role;
  return project;
}


fastify.get('/api/members', async (req, reply) => {
  const auth = await requireAuth(req, reply); if (!auth) return;
  const { rows } = await query(
    `SELECT om.user_id AS id, om.role, EXTRACT(EPOCH FROM om.created_at)::bigint AS joined_at,
            u.email, u.name, u.picture_url
     FROM organization_members om
     JOIN users u ON u.id = om.user_id
     WHERE om.organization_id = $1
     ORDER BY CASE om.role WHEN 'owner' THEN 1 WHEN 'admin' THEN 2 WHEN 'developer' THEN 3 ELSE 4 END, om.created_at ASC`,
    [auth.organization.id],
  );
  return rows.map((row) => ({ ...row, role: normalizeOrgRole(row.role), is_current_user: row.id === auth.user.id }));
});

fastify.patch('/api/members/:userId', {
  schema: { body: { type: 'object', required: ['role'], properties: { role: { type: 'string' } } } },
}, async (req, reply) => {
  const auth = await requireOrgRole(req, reply, ['owner', 'admin']); if (!auth) return;
  const role = normalizeOrgRole(req.body?.role);
  if (role === 'owner') return reply.code(400).send(ERR('VALIDATION_ERROR', 'Owner transfers are not supported here.'));
  const userId = String(req.params.userId || '');
  if (userId === auth.user.id) return reply.code(400).send(ERR('VALIDATION_ERROR', 'You cannot change your own role.'));
  const { rows } = await query(
    `UPDATE organization_members SET role = $1, updated_at = NOW()
     WHERE organization_id = $2 AND user_id = $3 AND role <> 'owner'
     RETURNING user_id AS id, role`,
    [role, auth.organization.id, userId],
  );
  if (!rows[0]) return reply.code(404).send(ERR('MEMBER_NOT_FOUND', 'member not found'));
  return { success: true, member: rows[0] };
});

fastify.delete('/api/members/:userId', async (req, reply) => {
  const auth = await requireOrgRole(req, reply, ['owner', 'admin']); if (!auth) return;
  const userId = String(req.params.userId || '');
  if (userId === auth.user.id) return reply.code(400).send(ERR('VALIDATION_ERROR', 'You cannot remove yourself.'));
  const { rowCount } = await query(
    `DELETE FROM organization_members WHERE organization_id = $1 AND user_id = $2 AND role <> 'owner'`,
    [auth.organization.id, userId],
  );
  return { success: true, removed: rowCount > 0 };
});


fastify.post('/api/invites/accept', {
  schema: { body: { type: 'object', properties: { token: { type: 'string' }, inviteId: { type: 'string' } } } },
}, async (req, reply) => {
  const auth = await requireAuth(req, reply); if (!auth) return;
  const token = String(req.body?.token || '').trim();
  const inviteId = String(req.body?.inviteId || '').trim();
  if (!token && !inviteId) return reply.code(400).send(ERR('VALIDATION_ERROR', 'token or inviteId required'));
  const result = await acceptInviteForUser({ token: token || null, inviteId: inviteId || null, user: auth.user });
  if (result.error === 'INVITE_NOT_FOUND') return reply.code(404).send(ERR('INVITE_NOT_FOUND', 'Invite not found or expired.'));
  if (result.error === 'INVITE_EMAIL_MISMATCH') return reply.code(403).send(ERR('INVITE_EMAIL_MISMATCH', 'Sign in with the invited email address to accept this invite.'));
  return { success: true };
});

fastify.get('/api/invites', async (req, reply) => {
  const auth = await requireAuth(req, reply); if (!auth) return;
  const { rows } = await query(
    `SELECT oi.id, oi.organization_id, o.name AS organization_name, oi.email, oi.role,
            oi.invited_user_id, oi.accepted_by_user_id,
            oi.accepted_at IS NOT NULL AS accepted, oi.revoked_at IS NOT NULL AS revoked,
            EXTRACT(EPOCH FROM oi.created_at)::bigint AS created_at,
            EXTRACT(EPOCH FROM oi.expires_at)::bigint AS expires_at,
            EXTRACT(EPOCH FROM oi.accepted_at)::bigint AS accepted_at,
            inviter.name AS invited_by_name, inviter.email AS invited_by_email,
            invited.name AS invited_user_name, invited.email AS invited_user_email
     FROM organization_invites oi
     JOIN organizations o ON o.id = oi.organization_id
     LEFT JOIN users inviter ON inviter.id = oi.invited_by_user_id
     LEFT JOIN users invited ON invited.id = oi.invited_user_id
     WHERE oi.organization_id = $1 OR oi.invited_user_id = $2 OR LOWER(oi.email) = LOWER($3)
     ORDER BY oi.created_at DESC`,
    [auth.organization.id, auth.user.id, auth.user.email || ''],
  );
  return rows.map((row) => {
    const now = Math.floor(Date.now()/1000);
    const direction = row.organization_id === auth.organization.id ? 'sent' : 'received';
    return { ...row, role: normalizeOrgRole(row.role), direction, can_accept: direction === 'received' && !row.accepted && !row.revoked && (!row.expires_at || row.expires_at > now), status: row.accepted ? 'accepted' : row.revoked ? 'revoked' : (row.expires_at && row.expires_at < now) ? 'expired' : 'pending' };
  });
});

async function checkInviteeHandler(req, reply) {
  const auth = await requireOrgRole(req, reply, ['owner', 'admin']); if (!auth) return;
  const email = String(req.body?.email || req.query?.email || '').trim().toLowerCase();
  if (!isEmail(email)) return reply.code(400).send(ERR('VALIDATION_ERROR', 'valid email required'));
  const user = await findUserByEmail(email);
  const { rows: existingMembers } = await query(
    `SELECT 1 FROM organization_members om JOIN users u ON u.id = om.user_id WHERE om.organization_id = $1 AND LOWER(u.email) = $2 LIMIT 1`,
    [auth.organization.id, email],
  );
  return { email, exists: Boolean(user), already_member: Boolean(existingMembers[0]), user: user ? { id: user.id, email: user.email, name: user.name, picture_url: user.picture_url } : null };
}

fastify.post('/api/invites/check', {
  schema: { body: { type: 'object', required: ['email'], properties: { email: { type: 'string' } } } },
}, checkInviteeHandler);
fastify.get('/api/invites/check', checkInviteeHandler);
fastify.post('/api/invite/check', {
  schema: { body: { type: 'object', required: ['email'], properties: { email: { type: 'string' } } } },
}, checkInviteeHandler);
fastify.get('/api/invite/check', checkInviteeHandler);

fastify.post('/api/invites', {
  schema: { body: { type: 'object', required: ['email', 'role'], properties: { email: { type: 'string' }, role: { type: 'string' } } } },
}, async (req, reply) => {
  const auth = await requireOrgRole(req, reply, ['owner', 'admin']); if (!auth) return;
  const email = String(req.body?.email || '').trim().toLowerCase();
  const role = normalizeOrgRole(req.body?.role);
  if (!isEmail(email)) return reply.code(400).send(ERR('VALIDATION_ERROR', 'valid email required'));
  if (role === 'owner') return reply.code(400).send(ERR('VALIDATION_ERROR', 'Invite admin, developer, or viewer roles.'));
  const invitedUser = await findUserByEmail(email);
  const { rows: existingMembers } = await query(
    `SELECT 1 FROM organization_members om JOIN users u ON u.id = om.user_id WHERE om.organization_id = $1 AND LOWER(u.email) = $2 LIMIT 1`,
    [auth.organization.id, email],
  );
  if (existingMembers[0]) return reply.code(409).send(ERR('ALREADY_MEMBER', 'This user is already in this workspace.'));
  const token = randomUUID() + randomUUID().replace(/-/g, '');
  const id = randomUUID();
  await query(
    `INSERT INTO organization_invites (id, organization_id, email, role, token_hash, invited_by_user_id, invited_user_id, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,NOW() + INTERVAL '7 days')`,
    [id, auth.organization.id, email, role, hashToken(token), auth.user.id, invitedUser?.id || null],
  );
  let emailResult = { sent: false, skipped: true, reason: 'Existing Lethem user gets an in-app invite' };
  if (!invitedUser) {
    const emailContent = inviteEmailContent({ role, organizationName: auth.organization.name, inviterName: auth.user.name || auth.user.email, token });
    emailResult = await sendEmail({ to: email, ...emailContent });
    if (!emailResult.sent) req.log.error({ emailResult, invited_email: email }, 'invite email failed');
  }
  return { success: true, id, invited_email: email, invited_user: invitedUser ? { id: invitedUser.id, email: invitedUser.email, name: invitedUser.name, picture_url: invitedUser.picture_url } : null, user_exists: Boolean(invitedUser), role, invite_url: inviteLink(token), email_delivery: emailResult };
});

fastify.delete('/api/invites/:id', async (req, reply) => {
  const auth = await requireOrgRole(req, reply, ['owner', 'admin']); if (!auth) return;
  const { rowCount } = await query(
    `UPDATE organization_invites SET revoked_at = NOW(), updated_at = NOW() WHERE id = $1 AND organization_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
    [req.params.id, auth.organization.id],
  );
  return { success: true, revoked: rowCount > 0 };
});

fastify.get('/api/projects', async (req, reply) => {
  const auth = await requireAuth(req, reply); if (!auth) return;
  const { rows } = await query(
    `SELECT p.id,p.name,p.slug,p.status,p.organization_id,om.role AS organization_role,EXTRACT(EPOCH FROM p.created_at)::bigint AS created_at
     FROM projects p
     JOIN organization_members om ON om.organization_id = p.organization_id AND om.user_id = $1
     ORDER BY p.created_at DESC`,
    [auth.user.id],
  );
  return rows;
});

fastify.post('/api/projects', {
  schema: { body: { type: 'object', required: ['name'], properties: { name: { type: 'string', minLength: 1 }, slug: { type: 'string' } } } },
}, async (req, reply) => {
  const { name, slug = null } = req.body || {};
  if (!name) return reply.code(400).send(ERR('VALIDATION_ERROR', 'name required'));
  const auth = await requireOrgRole(req, reply, ['owner', 'admin']); if (!auth) return;
  const { rows: countRows } = await query('SELECT COUNT(*)::int AS c FROM projects WHERE organization_id = $1', [auth.organization.id]);
  const projectLimit = getPlanProjectLimit(auth.organization.plan);
  if ((countRows[0]?.c || 0) >= projectLimit) return reply.code(400).send(ERR('PROJECT_LIMIT_REACHED', `max ${projectLimit} projects allowed on your current plan`));
  const id = randomUUID();
  const generatedSlug = `project-${Math.random().toString(36).slice(2, 10)}`;
  await query(`INSERT INTO projects (id,name,slug,status,organization_id) VALUES ($1,$2,$3,$4,$5)`, [id, String(name).trim(), slug ? String(slug).trim() : generatedSlug, 'active', auth.organization.id]);
  return { id, name: String(name).trim(), slug: slug ? String(slug).trim() : generatedSlug, status: 'active', created_at: Math.floor(Date.now()/1000) };
});

async function deleteProjectByRef(req, reply, projectRef) {
  const auth = await requireOrgRole(req, reply, ['owner', 'admin']); if (!auth) return null;
  const ref = String(projectRef || '').trim();
  if (!ref) return { success: true, deleted: false, reason: 'empty_ref' };
  const { rows } = await query(
    `SELECT p.id,p.slug FROM projects p
     JOIN organization_members om ON om.organization_id = p.organization_id AND om.user_id = $2
     WHERE (p.slug = $1 OR p.id::text = $1) LIMIT 1`,
    [ref, auth.user.id],
  );
  const project = rows[0];
  if (!project) return { success: true, deleted: false, reason: 'not_found' };
  await query('DELETE FROM projects WHERE id = $1', [project.id]);
  return { success: true, deleted: true, id: project.id, slug: project.slug };
}

fastify.delete('/api/projects/:id', {
  schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1 } } } },
}, async (req, reply) => {
  try {
    return await deleteProjectByRef(req, reply, req.params.id);
  } catch (err) {
    req.log.error(err);
    return reply.code(500).send(ERR('INTERNAL_ERROR', 'failed to delete project'));
  }
});



fastify.route({
  method: ['DELETE'],
  url: '/api/projects/by-slug/:slug',
  handler: async (req, reply) => {
    try {
      return await deleteProjectByRef(req, reply, req.params.slug);
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ success: false, deleted: false, reason: 'internal_error' });
    }
  },
});

fastify.get('/api/master-keys', async (req, reply) => {
  const project = await getProject(req, reply); if (!project) return;
  const { rows } = await query(`
    SELECT id, provider, name, key_masked, key_version,
           EXTRACT(EPOCH FROM created_at)::bigint AS created_at,
           EXTRACT(EPOCH FROM updated_at)::bigint AS updated_at
    FROM master_keys WHERE project_id = $1 ORDER BY created_at DESC
  `, [project.id]);
  return rows;
});

fastify.post('/api/master-keys', {
  schema: { body: { type: 'object', required: ['provider', 'api_key'], properties: { provider: { type: 'string' }, api_key: { type: 'string', minLength: 1 }, name: { type: 'string' } } } },
}, async (req, reply) => {
  const project = await getProject(req, reply); if (!project) return;
  if (!['owner', 'admin'].includes(project.organization_role)) return reply.code(403).send(ERR('FORBIDDEN', 'Your organization role does not allow this action.'));
  const { provider, api_key, name } = req.body || {};
  if (!provider || !api_key) return reply.code(400).send(ERR('VALIDATION_ERROR', 'provider and api_key required'));
  if (!getProvider(provider)) return reply.code(400).send(ERR('UNKNOWN_PROVIDER', `Unknown provider ${provider}`));
  const encrypted = encryptSecret(api_key, provider);
  await query(
    `INSERT INTO master_keys (id, project_id, provider, name, key_masked, ciphertext_b64, iv_b64, auth_tag_b64, key_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [randomUUID(), project.id, provider, name || provider, maskKey(api_key), encrypted.ciphertext_b64, encrypted.iv_b64, encrypted.auth_tag_b64, encrypted.key_version],
  );
  return { success: true };
});


fastify.delete('/api/master-keys/:id', async (req, reply) => {
  const project = await getProject(req, reply); if (!project) return;
  if (!['owner', 'admin'].includes(project.organization_role)) return reply.code(403).send(ERR('FORBIDDEN', 'Your organization role does not allow this action.'));
  const { id } = req.params;
  try {
    await query('BEGIN');
    await query('UPDATE subkeys SET master_key_id = NULL WHERE master_key_id = $1 AND project_id = $2', [id, project.id]);
    const result = await query('DELETE FROM master_keys WHERE id = $1 AND project_id = $2', [id, project.id]);
    await query('COMMIT');
    if (!result.rowCount) return reply.code(404).send({ error: 'master key not found' });
    return { success: true };
  } catch (err) {
    await query('ROLLBACK').catch(() => {});
    if (/invalid input syntax for type uuid/i.test(String(err?.message || ''))) {
      return reply.code(400).send({ error: 'invalid master key id' });
    }
    throw err;
  }
});

fastify.delete('/api/subkeys/:id', async (req, reply) => {
  const project = await getProject(req, reply); if (!project) return;
  if (!['owner', 'admin', 'member'].includes(project.organization_role)) return reply.code(403).send(ERR('FORBIDDEN', 'Your organization role does not allow this action.'));
  await query('DELETE FROM subkeys WHERE id = $1 AND project_id = $2', [req.params.id, project.id]);
  return { success: true };
});

fastify.get('/api/subkeys', async (req, reply) => {
  const project = await getProject(req, reply); if (!project) return;
  const { rows } = await query(`SELECT id, name, token_prefix, token_ciphertext_b64, token_iv_b64, token_auth_tag_b64, provider, master_key_id, auto_route_on_exhausted, monthly_token_limit, requests_per_minute_limit, tokens_used, status, spend_limit_usd, max_requests, request_count, allowed_models, EXTRACT(EPOCH FROM expires_at)::bigint AS expires_at, EXTRACT(EPOCH FROM created_at)::bigint AS created_at FROM subkeys WHERE project_id = $1 ORDER BY created_at DESC`, [project.id]);
  return rows.map((row) => {
    let token_preview = `${row.token_prefix || 'sk-lt-'}••••`;
    if (row.token_prefix && row.token_ciphertext_b64 && row.token_iv_b64 && row.token_auth_tag_b64) {
      try {
        const token = decryptSecret({ ciphertext_b64: row.token_ciphertext_b64, iv_b64: row.token_iv_b64, auth_tag_b64: row.token_auth_tag_b64 }, `subkey:${row.id}`);
        token_preview = `${token.slice(0, 12)}••••••••${token.slice(-4)}`;
      } catch (_) {}
    }
    return { ...row, token_preview, token: undefined, token_ciphertext_b64: undefined, token_iv_b64: undefined, token_auth_tag_b64: undefined };
  });
});

fastify.get('/api/subkeys/:id/demo-token', async (req, reply) => {
  const project = await getProject(req, reply); if (!project) return;
  const ip = req.ip || 'unknown';
  const demoKey = `rl:demo-token:${project.id}:${ip}`;
  let demoCount = null;
  try {
    demoCount = await incrementRedisWindow(demoKey, 60);
  } catch (err) {
    req.log.warn({ err }, 'redis demo-token rate limit check failed; allowing request');
  }
  if (demoCount !== null && demoCount > 20) return reply.code(429).send(ERR('RATE_LIMITED', 'too many demo token requests'));
  const { rows } = await query(
    `SELECT id, status, token_ciphertext_b64, token_iv_b64, token_auth_tag_b64
     FROM subkeys WHERE id = $1 AND project_id = $2 LIMIT 1`,
    [req.params.id, project.id],
  );
  const row = rows[0];
  if (!row) return reply.code(404).send(ERR('SUBKEY_NOT_FOUND', 'subkey not found'));
  if (row.status !== 'active') return reply.code(403).send(ERR('SUBKEY_INACTIVE', 'subkey is not active'));
  if (!row.token_ciphertext_b64 || !row.token_iv_b64 || !row.token_auth_tag_b64) {
    return reply.code(400).send(ERR('TOKEN_NOT_AVAILABLE', 'token not available'));
  }
  const token = decryptSecret(
    { ciphertext_b64: row.token_ciphertext_b64, iv_b64: row.token_iv_b64, auth_tag_b64: row.token_auth_tag_b64 },
    `subkey:${row.id}`,
  );
  return { token };
});

fastify.patch('/api/subkeys/:id', {
  schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
}, async (req, reply) => {
  const project = await getProject(req, reply); if (!project) return;
  if (!['owner', 'admin', 'member'].includes(project.organization_role)) return reply.code(403).send(ERR('FORBIDDEN', 'Your organization role does not allow this action.'));
  const { id } = req.params;
  const body = req.body || {};
  const updates = [];
  const values = [];

  if (body.status !== undefined) {
    if (!['active', 'paused', 'revoked'].includes(body.status)) return reply.code(400).send(ERR('VALIDATION_ERROR', 'status must be active|paused|revoked'));
    updates.push(`status = $${values.length + 1}`);
    values.push(body.status);
  }
  if (body.monthly_token_limit !== undefined) {
    const v = Number(body.monthly_token_limit);
    if (!Number.isFinite(v) || v < 1) return reply.code(400).send({ error: 'monthly_token_limit must be a positive number' });
    updates.push(`monthly_token_limit = $${values.length + 1}`);
    values.push(Math.round(v));
  }
  if (body.max_requests !== undefined) {
    const v = Number(body.max_requests);
    if (!Number.isFinite(v) || v < 1) return reply.code(400).send({ error: 'max_requests must be a positive number' });
    updates.push(`max_requests = $${values.length + 1}`);
    values.push(Math.round(v));
  }
  if (body.expires_in_days !== undefined) {
    if (body.expires_in_days === null || body.expires_in_days === '') {
      updates.push(`expires_at = NULL`);
    } else {
      const v = Number(body.expires_in_days);
      if (!Number.isFinite(v) || v < 1) return reply.code(400).send({ error: 'expires_in_days must be a positive number or null' });
      updates.push(`expires_at = NOW() + ($${values.length + 1} || ' days')::interval`);
      values.push(String(Math.round(v)));
    }
  }

  if (!updates.length) return reply.code(400).send({ error: 'no editable fields provided' });
  values.push(id);
  values.push(project.id);
  const { rows } = await query(`UPDATE subkeys SET ${updates.join(', ')} WHERE id = $${values.length - 1} AND project_id = $${values.length} RETURNING id,name,provider,monthly_token_limit,max_requests,status,EXTRACT(EPOCH FROM expires_at)::bigint AS expires_at`, values);
  if (!rows[0]) return reply.code(404).send(ERR('SUBKEY_NOT_FOUND', 'subkey not found'));
  return { success: true, subkey: rows[0] };
});

fastify.post('/api/subkeys', {
  schema: { body: { type: 'object', required: ['name', 'provider'], properties: { name: { type: 'string', minLength: 1 }, provider: { type: 'string' }, master_key_id: { type: ['string', 'null'] } } } },
}, async (req, reply) => {
  const project = await getProject(req, reply); if (!project) return;
  if (!['owner', 'admin', 'member'].includes(project.organization_role)) return reply.code(403).send(ERR('FORBIDDEN', 'Your organization role does not allow this action.'));
  const { name, provider, master_key_id = null, auto_route_on_exhausted = false, monthly_token_limit = 50000, max_requests = 5000, allowed_models = ['all'], spend_limit_usd = null, expires_in_days = null } = req.body || {};
  if (!name || !provider) return reply.code(400).send(ERR('VALIDATION_ERROR', 'name and provider required'));
  const providerConfig = getProvider(provider);
  if (!providerConfig) return reply.code(400).send(ERR('UNKNOWN_PROVIDER', `Unknown provider ${provider}`));
  const normalizedAllowed = normalizeAllowedModels(allowed_models);
  const invalidModels = normalizedAllowed.includes('all') ? [] : normalizedAllowed.filter((model) => !isModelAllowedForProvider(provider, model));
  if (invalidModels.length) return reply.code(400).send(ERR('MODEL_PROVIDER_MISMATCH', `Models not valid for ${provider}: ${invalidModels.join(', ')}`));
  const storedAllowed = normalizedAllowed.includes('all') ? ['all'] : normalizedAllowed.map((model) => normalizeProviderModel(provider, model));
  const id = randomUUID();
  const token = `sk-lt-${randomUUID().replace(/-/g, '')}`;
  const enc = encryptSecret(token, `subkey:${id}`);
  const expiresAt = expires_in_days ? new Date(Date.now() + Number(expires_in_days) * 86400 * 1000) : null;
  await query(`INSERT INTO subkeys (id,project_id,name,token_hash,token_prefix,token_ciphertext_b64,token_iv_b64,token_auth_tag_b64,token_key_version,provider,master_key_id,auto_route_on_exhausted,monthly_token_limit,requests_per_minute_limit,spend_limit_usd,max_requests,allowed_models,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`, [id, project.id, name, hashToken(token), token.slice(0, 12), enc.ciphertext_b64, enc.iv_b64, enc.auth_tag_b64, enc.key_version, provider, master_key_id, Boolean(auto_route_on_exhausted), Number(monthly_token_limit) || 50000, DEFAULT_RPM_LIMIT, spend_limit_usd, Number(max_requests) || 5000, JSON.stringify(storedAllowed), expiresAt]);
  return { id, name, provider, token_prefix: token.slice(0, 12), token, requests_per_minute_limit: DEFAULT_RPM_LIMIT };
});

fastify.get('/api/providers', async () => ({ providers: listProviders() }));
fastify.get('/api/models', async (req) => ({ data: listModels(req.query?.provider) }));

fastify.get('/api/analytics', async (req, reply) => {
  const project = await getProject(req, reply); if (!project) return;
  const [{ rows: totals }, { rows: logs }] = await Promise.all([
    query(`SELECT COUNT(*)::int AS total_requests, COALESCE(SUM(tokens_used),0)::int AS total_tokens FROM request_logs WHERE project_id = $1`, [project.id]),
    query(`SELECT id,request_id,subkey_id,subkey_name,provider,model,tokens_used,prompt_tokens,completion_tokens,estimated_cost_usd,status,error_reason,source,latency_ms,EXTRACT(EPOCH FROM created_at)::bigint AS created_at FROM request_logs WHERE project_id = $1 ORDER BY created_at DESC LIMIT 200`, [project.id]),
  ]);
  const totalRequests = totals[0]?.total_requests || 0;
  const totalTokens = totals[0]?.total_tokens || 0;
  const avgLatency = logs.length ? Math.round(logs.reduce((s, r) => s + Number(r.latency_ms || 0), 0) / logs.length) : 0;
  const topModels = [...logs.reduce((m, r) => (m.set(r.model || 'unknown', (m.get(r.model || 'unknown') || 0) + 1), m), new Map()).entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([model, count]) => ({ model, count }));
  const costAttribution = logs.map((l) => ({
    provider: l.provider || 'unknown',
    model: l.model || 'unknown',
    est_cost_usd: Number(l.estimated_cost_usd || 0),
  }));
  return { totalRequests, totalTokens, avgLatency, topModels, logs, costAttribution };
});

fastify.get('/api/quota-requests', async (req, reply) => {
  const project = await getProject(req, reply); if (!project) return;
  await query(`DELETE FROM quota_requests WHERE project_id = $1 AND status IN ('approved','rejected') AND created_at < NOW() - INTERVAL '24 hours'`, [project.id]);
  const { rows } = await query(`SELECT q.id,q.subkey_id,s.name AS subkey_name,q.request_type,q.amount,q.note,q.status,EXTRACT(EPOCH FROM q.created_at)::bigint AS created_at FROM quota_requests q LEFT JOIN subkeys s ON s.id=q.subkey_id WHERE q.project_id = $1 ORDER BY q.created_at DESC`, [project.id]);
  return rows;
});


fastify.patch('/api/quota-requests/:id', {
  schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } }, body: { type: 'object', required: ['status'], properties: { status: { type: 'string' } } } },
}, async (req, reply) => {
  const project = await getProject(req, reply); if (!project) return;
  if (!['owner', 'admin', 'member'].includes(project.organization_role)) return reply.code(403).send(ERR('FORBIDDEN', 'Your organization role does not allow this action.'));
  if (!isUuid(req.params.id)) return reply.code(400).send(ERR('INVALID_ID', 'invalid quota request id'));
  const { status } = req.body || {};
  if (!['approved', 'rejected', 'pending'].includes(status)) return reply.code(400).send(ERR('VALIDATION_ERROR', 'status must be approved|rejected|pending'));
  const { rows } = await query('UPDATE quota_requests SET status = $1 WHERE id = $2 AND project_id = $3 RETURNING *', [status, req.params.id, project.id]);
  const r = rows[0];
  if (r && status === 'approved') {
    if (r.request_type === 'credits' && r.amount) {
      const add = Math.max(0, Number(String(r.amount).replace(/[^0-9.]/g, '')) || 0) * 1000;
      await query('UPDATE subkeys SET monthly_token_limit = COALESCE(monthly_token_limit,0) + $1 WHERE id = $2', [Math.round(add), r.subkey_id]);
    }
    if (r.request_type === 'expiry_extend' && r.amount) {
      const days = Math.max(0, Number(String(r.amount).replace(/[^0-9.]/g, '')) || 0);
      await query("UPDATE subkeys SET expires_at = COALESCE(expires_at, NOW()) + ($1 || ' days')::interval WHERE id = $2", [String(Math.round(days)), r.subkey_id]);
    }
  }
  await query(`DELETE FROM quota_requests WHERE project_id = $1 AND status IN ('approved','rejected') AND created_at < NOW() - INTERVAL '24 hours'`, [project.id]);
  return { success: true };
});

fastify.post('/api/quota-requests', {
  schema: { body: { type: 'object', required: ['subkey_id', 'request_type'], properties: { subkey_id: { type: 'string' }, request_type: { type: 'string' }, amount: { type: ['string', 'null'] }, note: { type: 'string' } } } },
}, async (req, reply) => {
  const project = await getProject(req, reply); if (!project) return;
  const { subkey_id, request_type, amount = null, note = '' } = req.body || {};
  if (!subkey_id || !request_type) return reply.code(400).send(ERR('VALIDATION_ERROR', 'subkey_id and request_type required'));
  const id = randomUUID();
  await query(`INSERT INTO quota_requests (id,project_id,subkey_id,request_type,amount,note,status) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, project.id, subkey_id, request_type, amount ? String(amount) : null, note, 'pending']);
  return { success: true, id };
});

fastify.post('/v1/chat/completions', async (req, reply) => {
  const started = Date.now();
  const payload = req.body || {};
  const source = req.headers['x-lethem-client'] || req.headers['x-keygate-client'] || 'external';
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const finishMs = () => Date.now() - started;
  if (!bearer) {
    req.log.warn({ event: 'gateway_request_rejected', error_reason: 'missing_authorization', provider: null, model: payload.model || null }, 'gateway request rejected');
    return reply.code(401).send(ERR('MISSING_AUTHORIZATION', 'Missing Authorization header.'));
  }

  const { rows } = await query(`SELECT id,project_id,name,provider,master_key_id,auto_route_on_exhausted,status,requests_per_minute_limit,max_requests,request_count,monthly_token_limit,tokens_used,expires_at,allowed_models FROM subkeys WHERE token_hash = $1`, [hashToken(bearer)]);
  const subkey = rows[0];
  if (!subkey) {
    req.log.warn({ event: 'gateway_request_rejected', error_reason: 'invalid_token', provider: null, model: payload.model || null }, 'gateway request rejected');
    return reply.code(401).send(ERR('INVALID_TOKEN', 'Invalid subkey.'));
  }

  const requestedModel = normalizeProviderModel(subkey.provider, payload.model || getDefaultModel(subkey.provider)) || null;

  const logAndReject = async (httpCode, errorCode, message, status, errorReason) => {
    await insertRequestLog({ req, subkey, model: requestedModel, status, errorReason, source, latencyMs: finishMs() });
    return reply.code(httpCode).send(ERR(errorCode, message));
  };

  if (subkey.status !== 'active') return logAndReject(403, 'SUBKEY_INACTIVE', `Subkey is ${subkey.status}.`, 'rejected', 'subkey_inactive');
  if (subkey.expires_at && new Date(subkey.expires_at).getTime() < Date.now()) return logAndReject(403, 'SUBKEY_EXPIRED', 'Subkey expired.', 'rejected', 'subkey_expired');
  if (Number(subkey.request_count || 0) >= Number(subkey.max_requests || 5000)) return logAndReject(403, 'MAX_REQUESTS_REACHED', 'Max requests reached.', 'max_requests_reached', 'max_requests_reached');
  if (Number(subkey.tokens_used || 0) >= Number(subkey.monthly_token_limit || 0)) return logAndReject(403, 'QUOTA_EXCEEDED', 'Quota reached for this subkey. Please use /api/quota-requests endpoint to request a quota extension.', 'quota_reached', 'quota_exceeded');

  const rate = await rateLimitBySubkey(subkey.id, Number(subkey.requests_per_minute_limit || DEFAULT_RPM_LIMIT));
  reply.header('X-RateLimit-Limit', String(rate.limit));
  reply.header('X-RateLimit-Remaining', String(rate.remaining));
  reply.header('X-RateLimit-Reset', String(rate.reset));
  if (!rate.allowed) return logAndReject(429, 'RATE_LIMIT_EXCEEDED', 'Too many requests. Try again later.', 'rate_limited', 'rate_limit_exceeded');

  const providerConfig = getProvider(subkey.provider);
  if (!providerConfig) return logAndReject(400, 'UNKNOWN_PROVIDER', `Unknown provider ${subkey.provider}`, 'config_error', 'unknown_provider');
  const modelOwner = getProviderForModel(requestedModel);
  if (!modelOwner) return logAndReject(400, 'UNKNOWN_MODEL', `Unknown model ${requestedModel}`, 'rejected', 'unknown_model');
  if (modelOwner.id !== subkey.provider) {
    return logAndReject(400, 'MODEL_PROVIDER_MISMATCH', `Model ${requestedModel} does not match provider ${subkey.provider}`, 'rejected', 'model_provider_mismatch');
  }
  const allowedModels = normalizeAllowedModels(subkey.allowed_models);
  const resolvedAllowedModels = allowedModels.includes('all') ? ['all'] : allowedModels.map((model) => normalizeProviderModel(subkey.provider, model)).filter(Boolean);
  const allowed = resolvedAllowedModels.includes('all') || resolvedAllowedModels.includes(requestedModel);
  if (!allowed) return logAndReject(403, 'MODEL_NOT_ALLOWED', 'Model not allowed for this subkey.', 'rejected', 'model_not_allowed');

  const mkQuery = subkey.master_key_id
    ? query('SELECT * FROM master_keys WHERE id = $1 AND provider = $2 AND project_id = $3 LIMIT 1', [subkey.master_key_id, subkey.provider, subkey.project_id])
    : query('SELECT * FROM master_keys WHERE provider = $1 AND project_id = $2 ORDER BY created_at DESC LIMIT 1', [subkey.provider, subkey.project_id]);
  const { rows: mkRows } = await mkQuery;
  const mk = mkRows[0];
  if (!mk) return logAndReject(400, 'MASTER_KEY_MISSING', `No master key found for provider ${subkey.provider}.`, 'config_error', 'master_key_missing');

  const providerKey = decryptSecret(mk, subkey.provider);
  let status = 'success'; let errorReason = null; let responseBody; let statusCode = 200;
  let tokensUsed = 0; let promptTokens = 0; let completionTokens = 0; let estimatedCostUsd = 0;
  try {
    const upstream = await callProvider({ provider: providerConfig, apiKey: providerKey, payload, model: requestedModel });
    const rawBody = await upstream.json().catch(() => ({}));
    responseBody = normalizeProviderResponse(providerConfig, rawBody, upstream.ok);
    statusCode = upstream.status;
    if (!upstream.ok) {
      status = upstream.status === 429 ? 'rate_limited' : 'error';
      errorReason = upstream.status === 429 ? 'upstream_rate_limited' : 'upstream_error';
    }
    const usage = normalizeUsage(responseBody);
    tokensUsed = usage.totalTokens;
    promptTokens = usage.promptTokens;
    completionTokens = usage.completionTokens;
    estimatedCostUsd = estimateCostUsd(subkey.provider, requestedModel, promptTokens, completionTokens, tokensUsed);
  } catch (e) {
    status = 'error'; errorReason = 'upstream_exception'; responseBody = { error: { message: e.message || 'Upstream request failed', type: 'upstream_error' } }; statusCode = 502;
  }

  await insertRequestLog({ req, subkey, model: requestedModel, tokensUsed, promptTokens, completionTokens, status, errorReason, source, latencyMs: finishMs(), estimatedCostUsd });
  await query(`UPDATE subkeys SET tokens_used = COALESCE(tokens_used,0) + $1, request_count = COALESCE(request_count,0) + 1 WHERE id = $2`, [tokensUsed, subkey.id]);
  return reply.code(statusCode).send(responseBody);
});

async function start() {
  await redis.connect();
  await initDb();
  await query(`CREATE TABLE IF NOT EXISTS health_daily (
    day DATE PRIMARY KEY,
    internal_ok BOOLEAN NOT NULL DEFAULT false,
    db_ok BOOLEAN NOT NULL DEFAULT false,
    redis_ok BOOLEAN NOT NULL DEFAULT false,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await query(`CREATE TABLE IF NOT EXISTS app_error_logs (
    id UUID PRIMARY KEY,
    request_id TEXT,
    method TEXT,
    path TEXT,
    message TEXT NOT NULL,
    stack TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await query(`ALTER TABLE request_logs
    ADD COLUMN IF NOT EXISTS request_id TEXT,
    ADD COLUMN IF NOT EXISTS provider TEXT,
    ADD COLUMN IF NOT EXISTS error_reason TEXT,
    ADD COLUMN IF NOT EXISTS prompt_tokens INTEGER DEFAULT 0,
    ADD COLUMN IF NOT EXISTS completion_tokens INTEGER DEFAULT 0,
    ADD COLUMN IF NOT EXISTS estimated_cost_usd NUMERIC(12,6) DEFAULT 0`);
  const { rows: schemaChecks } = await query(`
    SELECT
      EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='projects') AS projects_ok,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='subkeys' AND column_name='token_ciphertext_b64') AS subkeys_token_cipher_ok,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='subkeys' AND column_name='token_iv_b64') AS subkeys_token_iv_ok,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='subkeys' AND column_name='token_auth_tag_b64') AS subkeys_token_tag_ok,
      EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='health_daily') AS health_ok,
      EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='app_error_logs') AS error_logs_ok,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='request_logs' AND column_name='request_id') AS request_log_request_id_ok,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='request_logs' AND column_name='provider') AS request_log_provider_ok,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='request_logs' AND column_name='error_reason') AS request_log_error_reason_ok,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='request_logs' AND column_name='estimated_cost_usd') AS request_log_cost_ok,
      EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='users') AS users_ok,
      EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='organizations') AS organizations_ok,
      EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='organization_members') AS organization_members_ok,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='projects' AND column_name='organization_id') AS project_org_ok,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='organizations' AND column_name='plan') AS org_plan_ok,
      EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='billing_events') AS billing_events_ok,
      EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='organization_invites') AS organization_invites_ok,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='organization_invites' AND column_name='invited_user_id') AS organization_invites_user_ok
  `);
  const c = schemaChecks[0] || {};
  if (!(c.projects_ok && c.subkeys_token_cipher_ok && c.subkeys_token_iv_ok && c.subkeys_token_tag_ok && c.health_ok && c.error_logs_ok && c.request_log_request_id_ok && c.request_log_provider_ok && c.request_log_error_reason_ok && c.request_log_cost_ok && c.users_ok && c.organizations_ok && c.organization_members_ok && c.project_org_ok && c.org_plan_ok && c.billing_events_ok && c.organization_invites_ok && c.organization_invites_user_ok)) {
    throw new Error('Schema drift detected. Apply migrations in order: 001_initial_postgres.sql, 002_health_monitoring.sql, 003_request_error_logs.sql, 004_request_log_details.sql, 005_auth_organizations.sql, 006_billing_subscriptions.sql, 007_members_invites.sql, 008_invited_user_relation.sql');
  }

  const writeDailyHealth = async () => {
    let db_ok = false; let redis_ok = false;
    try { await query('SELECT 1'); db_ok = true; } catch (_) {}
    try { await pingRedis(); redis_ok = true; } catch (_) {}
    const internal_ok = db_ok && redis_ok;
    await query(
      `INSERT INTO health_daily (day, internal_ok, db_ok, redis_ok, details, updated_at)
       VALUES (CURRENT_DATE, $1, $2, $3, $4::jsonb, NOW())
       ON CONFLICT (day) DO UPDATE SET internal_ok=EXCLUDED.internal_ok, db_ok=EXCLUDED.db_ok, redis_ok=EXCLUDED.redis_ok, details=EXCLUDED.details, updated_at=NOW()`,
      [internal_ok, db_ok, redis_ok, JSON.stringify({ checked_at: Date.now() })],
    );
  };
  await writeDailyHealth();
  setInterval(writeDailyHealth, 24 * 60 * 60 * 1000);
  const port = 3001;
  await fastify.listen({ port, host: '0.0.0.0' });
  console.log(`🚀 Server running on http://localhost:${port}`);
}

start().catch((err) => { console.error(err); process.exit(1); });
