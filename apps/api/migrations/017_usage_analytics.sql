ALTER TABLE organization_policies
  ADD COLUMN usage_analytics_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN usage_analytics_epoch UUID NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN usage_analytics_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN usage_member_visibility_default BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN usage_retention_days INTEGER,
  ADD COLUMN usage_settings_revision BIGINT NOT NULL DEFAULT 1,
  ADD COLUMN usage_settings_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN usage_settings_updated_by_user_id TEXT REFERENCES "user"(id),
  ADD CONSTRAINT organization_usage_retention_days_check
    CHECK (usage_retention_days IS NULL OR usage_retention_days IN (30, 90, 180, 365)),
  ADD CONSTRAINT organization_usage_settings_revision_check
    CHECK (usage_settings_revision > 0);

ALTER TABLE member
  ADD CONSTRAINT member_id_organization_unique UNIQUE (id, "organizationId"),
  ADD CONSTRAINT member_id_organization_user_unique
    UNIQUE (id, "organizationId", "userId");
ALTER TABLE devices
  ADD CONSTRAINT devices_id_organization_unique UNIQUE (id, organization_id);

CREATE TABLE member_usage_analytics_state (
  member_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organization(id),
  visibility_override BOOLEAN,
  collection_epoch UUID,
  collection_started_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by_user_id TEXT REFERENCES "user"(id),
  CONSTRAINT member_usage_state_organization_member_unique
    UNIQUE (organization_id, member_id),
  CONSTRAINT member_usage_state_member_organization_fk
    FOREIGN KEY (member_id, organization_id)
    REFERENCES member(id, "organizationId") ON DELETE CASCADE,
  CONSTRAINT member_usage_collection_epoch_pair_check CHECK (
    (collection_epoch IS NULL AND collection_started_at IS NULL)
    OR (collection_epoch IS NOT NULL AND collection_started_at IS NOT NULL)
  )
);

CREATE TABLE usage_analytics_principals (
  id UUID PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organization(id),
  member_id TEXT REFERENCES member(id) ON DELETE SET NULL,
  user_id TEXT REFERENCES "user"(id),
  display_name TEXT,
  email TEXT,
  anonymized BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  anonymized_at TIMESTAMPTZ,
  CONSTRAINT usage_principal_identity_check CHECK (
    (anonymized = FALSE AND member_id IS NOT NULL AND user_id IS NOT NULL
      AND display_name IS NOT NULL AND email IS NOT NULL AND anonymized_at IS NULL)
    OR
    (anonymized = TRUE AND member_id IS NULL AND user_id IS NULL
      AND display_name IS NULL AND email IS NULL AND anonymized_at IS NOT NULL)
  ),
  CONSTRAINT usage_principal_member_identity_organization_fk
    FOREIGN KEY (member_id, organization_id, user_id)
    REFERENCES member(id, "organizationId", "userId"),
  CONSTRAINT usage_principal_id_organization_unique UNIQUE (id, organization_id)
);
CREATE UNIQUE INDEX usage_principal_active_member_unique
  ON usage_analytics_principals (organization_id, member_id)
  WHERE member_id IS NOT NULL;
CREATE UNIQUE INDEX usage_principal_anonymous_organization_unique
  ON usage_analytics_principals (organization_id)
  WHERE anonymized = TRUE;

INSERT INTO usage_analytics_principals (
  id, organization_id, member_id, user_id, display_name, email
)
SELECT
  gen_random_uuid(), members."organizationId", members.id,
  users.id, users.name, users.email
FROM member members
JOIN "user" users ON users.id = members."userId";

INSERT INTO usage_analytics_principals (
  id, organization_id, anonymized, anonymized_at
)
SELECT gen_random_uuid(), organizations.id, TRUE, NOW()
FROM organization organizations;

CREATE TABLE usage_analytics_sources (
  id UUID PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organization(id),
  principal_id UUID NOT NULL,
  collection_epoch UUID NOT NULL,
  first_received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_device_id UUID,
  app_version TEXT NOT NULL CHECK (char_length(app_version) BETWEEN 1 AND 40),
  CONSTRAINT usage_source_id_organization_unique UNIQUE (id, organization_id),
  CONSTRAINT usage_source_principal_organization_fk
    FOREIGN KEY (principal_id, organization_id)
    REFERENCES usage_analytics_principals(id, organization_id),
  CONSTRAINT usage_source_device_organization_fk
    FOREIGN KEY (last_device_id, organization_id)
    REFERENCES devices(id, organization_id) ON DELETE SET NULL (last_device_id)
);
CREATE INDEX usage_sources_principal_idx
  ON usage_analytics_sources (organization_id, principal_id);
CREATE INDEX usage_sources_last_received_idx
  ON usage_analytics_sources (organization_id, last_received_at DESC);

CREATE TABLE usage_analytics_daily (
  usage_date DATE NOT NULL,
  organization_id TEXT NOT NULL,
  source_id UUID NOT NULL,
  agent_id TEXT NOT NULL CHECK (char_length(agent_id) BETWEEN 1 AND 32),
  model TEXT NOT NULL DEFAULT '' CHECK (char_length(model) <= 128),
  total_turns BIGINT NOT NULL CHECK (total_turns >= 0),
  input_tokens BIGINT NOT NULL CHECK (input_tokens >= 0),
  output_tokens BIGINT NOT NULL CHECK (output_tokens >= 0),
  cache_read_tokens BIGINT NOT NULL CHECK (cache_read_tokens >= 0),
  cache_write_tokens BIGINT NOT NULL CHECK (cache_write_tokens >= 0),
  estimated_cost_microusd BIGINT NOT NULL CHECK (estimated_cost_microusd >= 0),
  cost_covered_tokens BIGINT NOT NULL CHECK (cost_covered_tokens >= 0),
  app_version TEXT NOT NULL CHECK (char_length(app_version) BETWEEN 1 AND 40),
  pricing_version TEXT NOT NULL CHECK (char_length(pricing_version) BETWEEN 1 AND 40),
  first_received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (usage_date, organization_id, source_id, agent_id, model),
  CONSTRAINT usage_daily_source_organization_fk
    FOREIGN KEY (source_id, organization_id)
    REFERENCES usage_analytics_sources(id, organization_id)
    ON DELETE CASCADE
) PARTITION BY RANGE (usage_date);

CREATE INDEX usage_daily_organization_date_idx
  ON usage_analytics_daily (organization_id, usage_date);
CREATE INDEX usage_daily_agent_date_idx
  ON usage_analytics_daily (organization_id, agent_id, usage_date);
CREATE INDEX usage_daily_model_date_idx
  ON usage_analytics_daily (organization_id, model, usage_date);

CREATE OR REPLACE FUNCTION ensure_usage_analytics_partition(target_date DATE)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  month_start DATE := date_trunc('month', target_date)::date;
  month_end DATE := (month_start + INTERVAL '1 month')::date;
  partition_name TEXT := 'usage_analytics_daily_' || to_char(month_start, 'YYYYMM');
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('lori-usage-partition-' || partition_name));
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF usage_analytics_daily FOR VALUES FROM (%L) TO (%L)',
    partition_name,
    month_start,
    month_end
  );
END;
$$;

SELECT ensure_usage_analytics_partition(CURRENT_DATE);
SELECT ensure_usage_analytics_partition((CURRENT_DATE + INTERVAL '1 month')::date);
