CREATE OR REPLACE FUNCTION ensure_usage_anonymous_principal()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO usage_analytics_principals (
    id, organization_id, anonymized, anonymized_at
  ) VALUES (gen_random_uuid(), NEW.id, TRUE, NOW())
  ON CONFLICT (organization_id) WHERE anonymized = TRUE DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER organization_usage_anonymous_principal_insert
AFTER INSERT ON organization
FOR EACH ROW EXECUTE FUNCTION ensure_usage_anonymous_principal();

CREATE OR REPLACE FUNCTION ensure_usage_member_principal()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO usage_analytics_principals (
    id, organization_id, member_id, user_id, display_name, email
  )
  SELECT gen_random_uuid(), NEW."organizationId", NEW.id, users.id, users.name, users.email
  FROM "user" users
  WHERE users.id = NEW."userId"
  ON CONFLICT (organization_id, member_id) WHERE member_id IS NOT NULL DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER member_usage_principal_insert
AFTER INSERT ON member
FOR EACH ROW EXECUTE FUNCTION ensure_usage_member_principal();

-- Repair the short rolling-upgrade window between the analytics schema and
-- lifecycle triggers without changing or reconnecting former-member usage.
INSERT INTO usage_analytics_principals (
  id, organization_id, member_id, user_id, display_name, email
)
SELECT
  gen_random_uuid(), members."organizationId", members.id,
  users.id, users.name, users.email
FROM member members
JOIN "user" users ON users.id = members."userId"
ON CONFLICT (organization_id, member_id) WHERE member_id IS NOT NULL DO NOTHING;

INSERT INTO usage_analytics_principals (
  id, organization_id, anonymized, anonymized_at
)
SELECT gen_random_uuid(), organizations.id, TRUE, NOW()
FROM organization organizations
ON CONFLICT (organization_id) WHERE anonymized = TRUE DO NOTHING;
