-- Existing Lori installations may hold a bootstrap ETag created before usage
-- analytics existed. Rotate the shared policy revision once so upgraded
-- clients receive the additive usageAnalytics bootstrap field immediately.
UPDATE organization_policies
SET revision = revision + 1, updated_at = NOW();
