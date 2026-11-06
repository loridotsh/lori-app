-- Company-owned LLM provider connections. The upstream API credential is
-- encrypted by the API process and is never returned through browser or
-- desktop contracts. Member/team catalog policy remains the authorization
-- layer that decides who may receive a gateway credential.
CREATE TABLE organization_provider_gateways (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL,
  encrypted_api_key TEXT NOT NULL,
  enabled_models JSONB NOT NULL DEFAULT '[]'::jsonb,
  requests_per_minute INTEGER NOT NULL DEFAULT 60
    CHECK (requests_per_minute >= 1 AND requests_per_minute <= 600),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by_user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  updated_by_user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  UNIQUE (organization_id, provider_id),
  CONSTRAINT organization_provider_gateways_models_are_array
    CHECK (jsonb_typeof(enabled_models) = 'array')
);

CREATE INDEX organization_provider_gateways_organization_id_idx
  ON organization_provider_gateways (organization_id);
