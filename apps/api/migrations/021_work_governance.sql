CREATE TABLE organization_work_policies (
  organization_id TEXT PRIMARY KEY REFERENCES organization(id) ON DELETE CASCADE,
  policy JSONB NOT NULL DEFAULT '{"enabled":true,"personalInstallations":{"plugins":true,"providers":true,"skills":true},"managedCatalog":[],"providerModels":[],"forceAskMe":false,"memoryAllowed":true}'::jsonb
);
INSERT INTO organization_work_policies (organization_id) SELECT id FROM organization;
CREATE TABLE team_work_policies (
  team_id TEXT PRIMARY KEY REFERENCES team(id) ON DELETE CASCADE,
  policy JSONB NOT NULL
);
CREATE TABLE member_work_policy_overrides (
  member_id TEXT PRIMARY KEY REFERENCES member(id) ON DELETE CASCADE,
  overrides JSONB NOT NULL
);
CREATE TABLE team_member_work_policy_overrides (
  team_member_id TEXT PRIMARY KEY REFERENCES team_member(id) ON DELETE CASCADE,
  overrides JSONB NOT NULL
);
ALTER TABLE devices ADD COLUMN work_inventory JSONB;
ALTER TABLE usage_analytics_sources
  ADD COLUMN product TEXT NOT NULL DEFAULT 'code' CHECK (product IN ('code', 'work')),
  ADD COLUMN enrolled_at TIMESTAMPTZ;
CREATE INDEX usage_sources_product_idx ON usage_analytics_sources (organization_id, product, principal_id);
CREATE TABLE desktop_work_audit_receipts (
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  event_id UUID NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (device_id, event_id)
);
-- Existing connected clients must observe the new default Work policy.
UPDATE organization_policies SET revision = revision + 1, updated_at = NOW();
