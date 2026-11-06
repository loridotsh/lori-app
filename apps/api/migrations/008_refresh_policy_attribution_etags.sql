-- The desktop bootstrap now includes team membership and policy-source
-- attribution. Advance every organization revision once so existing devices
-- cannot keep a shape-compatible but attribution-free cached response.
UPDATE organization_policies
SET
  revision = revision + 1,
  updated_at = NOW();
