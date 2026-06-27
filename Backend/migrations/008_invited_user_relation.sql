ALTER TABLE organization_invites
  ADD COLUMN IF NOT EXISTS invited_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_organization_invites_invited_user_id ON organization_invites(invited_user_id);
