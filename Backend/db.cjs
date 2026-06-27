'use strict';

require('dotenv').config();
const { Pool } = require('pg');
const crypto = require('crypto');

function createPoolConfig() {
  if (process.env.DATABASE_URL) {
    return { connectionString: process.env.DATABASE_URL };
  }

  const config = {
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE || 'keyhive',
    user: process.env.PGUSER || 'postgres',
  };

  // Only set password when actually provided. Passing undefined triggers SCRAM errors.
  const pgPasswordRaw = process.env.PGPASSWORD || process.env.POSTGRES_PASSWORD || process.env.DB_PASSWORD || process.env.POSTGRESQL_PASSWORD || process.env.PGPASS || '';
  const pgPassword = typeof pgPasswordRaw === 'string' ? pgPasswordRaw.trim() : '';
  if (pgPassword.length > 0) {
    config.password = pgPassword;
  }

  return config;
}

const pool = new Pool(createPoolConfig());

function requireMasterKey() {
  const keyB64 = process.env.KEYHIVE_MASTER_KEY_BASE64;
  if (!keyB64) {
    throw new Error('Missing KEYHIVE_MASTER_KEY_BASE64. Set it in your .env file.');
  }
  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== 32) {
    throw new Error('KEYHIVE_MASTER_KEY_BASE64 must decode to exactly 32 bytes for AES-256-GCM.');
  }
  return key;
}

function encryptSecret(plaintext, aad = '') {
  const key = requireMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    key_version: 1,
    iv_b64: iv.toString('base64'),
    auth_tag_b64: authTag.toString('base64'),
    ciphertext_b64: ciphertext.toString('base64'),
  };
}

function decryptSecret(record, aad = '') {
  const key = requireMasterKey();
  const iv = Buffer.from(record.iv_b64, 'base64');
  const authTag = Buffer.from(record.auth_tag_b64, 'base64');
  const ciphertext = Buffer.from(record.ciphertext_b64, 'base64');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(authTag);

  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}


async function ensureAuthSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS projects (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT UNIQUE,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY,
      auth0_sub TEXT NOT NULL UNIQUE,
      email TEXT,
      name TEXT,
      picture_url TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS organizations (
      id UUID PRIMARY KEY,
      auth0_org_id TEXT UNIQUE,
      name TEXT NOT NULL,
      slug TEXT UNIQUE,
      owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS organization_members (
      organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner','admin','member','viewer')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (organization_id, user_id)
    );

    ALTER TABLE projects ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE;

    CREATE INDEX IF NOT EXISTS idx_users_auth0_sub ON users(auth0_sub);
    CREATE INDEX IF NOT EXISTS idx_organizations_owner_user_id ON organizations(owner_user_id);
    CREATE INDEX IF NOT EXISTS idx_organization_members_user_id ON organization_members(user_id);
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'free';
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS razorpay_customer_id TEXT;
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS razorpay_subscription_id TEXT;
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS subscription_status TEXT NOT NULL DEFAULT 'free';
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS current_period_end TIMESTAMPTZ;

    CREATE INDEX IF NOT EXISTS idx_projects_organization_id ON projects(organization_id);

    CREATE TABLE IF NOT EXISTS billing_events (
      id UUID PRIMARY KEY,
      organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      razorpay_subscription_id TEXT,
      razorpay_payment_id TEXT,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_billing_events_org ON billing_events(organization_id);
    CREATE INDEX IF NOT EXISTS idx_billing_events_subscription ON billing_events(razorpay_subscription_id);


    ALTER TABLE organization_members ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    ALTER TABLE organization_members DROP CONSTRAINT IF EXISTS organization_members_role_check;
    ALTER TABLE organization_members ADD CONSTRAINT organization_members_role_check CHECK (role IN ('owner','admin','developer','viewer','member'));

    CREATE TABLE IF NOT EXISTS organization_invites (
      id UUID PRIMARY KEY,
      organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('owner','admin','developer','viewer','member')),
      token_hash TEXT NOT NULL UNIQUE,
      invited_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      accepted_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      invited_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      accepted_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (organization_id, email, token_hash)
    );

    CREATE INDEX IF NOT EXISTS idx_organization_invites_org ON organization_invites(organization_id);
    CREATE INDEX IF NOT EXISTS idx_organization_invites_email ON organization_invites(LOWER(email));
    CREATE INDEX IF NOT EXISTS idx_organization_invites_token_hash ON organization_invites(token_hash);
    CREATE INDEX IF NOT EXISTS idx_organization_invites_invited_user_id ON organization_invites(invited_user_id);
  `);
}

async function query(text, params = []) {
  return pool.query(text, params);
}

async function initDb() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS master_keys (
        id UUID PRIMARY KEY,
        provider TEXT NOT NULL,
        name TEXT,
        key_masked TEXT NOT NULL,
        ciphertext_b64 TEXT NOT NULL,
        iv_b64 TEXT NOT NULL,
        auth_tag_b64 TEXT NOT NULL,
        key_version INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS subkeys (
        id UUID PRIMARY KEY,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        token_prefix TEXT NOT NULL,
        token_ciphertext_b64 TEXT,
        token_iv_b64 TEXT,
        token_auth_tag_b64 TEXT,
        token_key_version INTEGER,
        provider TEXT NOT NULL,
        monthly_token_limit INTEGER DEFAULT 100000,
        requests_per_minute_limit INTEGER DEFAULT 2,
        tokens_used INTEGER DEFAULT 0,
        status TEXT DEFAULT 'active',
        spend_limit_usd NUMERIC(12,4),
        max_requests INTEGER DEFAULT 5000,
        request_count INTEGER DEFAULT 0,
        allowed_models JSONB DEFAULT '"all"'::jsonb,
        expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      ALTER TABLE subkeys ADD COLUMN IF NOT EXISTS token_ciphertext_b64 TEXT;
      ALTER TABLE subkeys ADD COLUMN IF NOT EXISTS token_iv_b64 TEXT;
      ALTER TABLE subkeys ADD COLUMN IF NOT EXISTS token_auth_tag_b64 TEXT;
      ALTER TABLE subkeys ADD COLUMN IF NOT EXISTS token_key_version INTEGER;
      ALTER TABLE subkeys ADD COLUMN IF NOT EXISTS master_key_id UUID;
      ALTER TABLE subkeys ADD COLUMN IF NOT EXISTS auto_route_on_exhausted BOOLEAN NOT NULL DEFAULT false;

      ALTER TABLE master_keys DROP CONSTRAINT IF EXISTS master_keys_provider_key;

      CREATE TABLE IF NOT EXISTS request_logs (
        id UUID PRIMARY KEY,
        subkey_id TEXT NOT NULL,
        subkey_name TEXT,
        model TEXT,
        tokens_used INTEGER DEFAULT 0,
        status TEXT,
        source TEXT DEFAULT 'external',
        latency_ms INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS quota_requests (
        id UUID PRIMARY KEY,
        subkey_id UUID NOT NULL,
        request_type TEXT NOT NULL,
        amount TEXT,
        note TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await ensureAuthSchema();
  } catch (err) {
    if (err && /client password must be a string|no password supplied|SASL|SCRAM/i.test(err.message || '')) {
      throw new Error(
        'PostgreSQL auth failed. Set one of PGPASSWORD, POSTGRES_PASSWORD, DB_PASSWORD, POSTGRESQL_PASSWORD, PGPASS, or a DATABASE_URL with a non-empty password. Also ensure the .env file is loaded from the backend process working directory.'
      );
    }
    throw err;
  }
}

module.exports = {
  query,
  initDb,
  encryptSecret,
  decryptSecret,
};
