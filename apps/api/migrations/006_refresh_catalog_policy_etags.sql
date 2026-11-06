-- Migration 005 changes the meaning and payload shape of organization catalog
-- rows. Advance every policy revision once so already-enrolled desktops cannot
-- retain a pre-migration managed catalog through a matching ETag.
UPDATE organization_policies
SET revision = revision + 1, updated_at = NOW();
