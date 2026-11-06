-- A connection's Work models can follow the provider's own listing, so members
-- get every usable model without an administrator maintaining a list. Only
-- providers whose listing identifies chat models and tool support are honored.
ALTER TABLE organization_provider_gateways
  ADD COLUMN work_model_sync BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN work_synced_models JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(work_synced_models) = 'array'),
  ADD COLUMN work_models_checked_at TIMESTAMPTZ;
