-- Work-only, administrator-configured prices. Does not alter Code model assignments.
ALTER TABLE organization_provider_gateways
  ADD COLUMN work_model_pricing JSONB NOT NULL DEFAULT '{}'::jsonb
  CHECK (jsonb_typeof(work_model_pricing) = 'object');
