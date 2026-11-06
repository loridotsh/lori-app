ALTER TABLE devices
  ADD COLUMN inventory JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN inventory_policy_revision BIGINT,
  ADD COLUMN inventory_reported_at TIMESTAMPTZ,
  ADD COLUMN inventory_sync_status TEXT
    CHECK (inventory_sync_status IN ('synced', 'error')),
  ADD COLUMN inventory_sync_error TEXT;

ALTER TABLE devices
  ADD CONSTRAINT devices_inventory_is_array
  CHECK (jsonb_typeof(inventory) = 'array');
