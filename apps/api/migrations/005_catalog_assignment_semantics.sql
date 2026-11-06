-- Organization catalog rows are positive assignments. An absent row leaves the
-- item governed by the effective personal-installation policy. Per-member rows
-- retain their tri-state semantics and may explicitly allow or block an item.
DELETE FROM organization_catalog_policies
WHERE enabled = FALSE;

ALTER TABLE organization_catalog_policies
  ADD CONSTRAINT organization_catalog_policies_assignments_only
  CHECK (enabled);
