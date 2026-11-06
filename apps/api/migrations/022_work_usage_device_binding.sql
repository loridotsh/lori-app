-- Work source identity belongs to its original enrolled device, independently
-- of Code's intentionally transferable last_device_id reporting metadata.
ALTER TABLE usage_analytics_sources
  ADD COLUMN work_device_id UUID,
  ADD CONSTRAINT usage_source_work_device_organization_fk
    FOREIGN KEY (work_device_id, organization_id)
    REFERENCES devices(id, organization_id) ON DELETE SET NULL (work_device_id),
  ADD CONSTRAINT usage_source_work_device_product_check
    CHECK (product = 'work' OR work_device_id IS NULL);
UPDATE usage_analytics_sources
SET work_device_id = last_device_id
WHERE product = 'work';
