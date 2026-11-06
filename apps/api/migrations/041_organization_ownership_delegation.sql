-- Organization ownership and the delegation ceiling for team administration.
-- Additive: no existing grant is removed. The report written at the end lists
-- what each organization should review.

ALTER TABLE member DROP CONSTRAINT member_role_check;
ALTER TABLE member
  ADD CONSTRAINT member_role_check CHECK (role IN ('owner', 'admin', 'member'));
-- Exactly one Owner per organization; transfers demote before they promote.
CREATE UNIQUE INDEX member_single_owner_idx
  ON member ("organizationId") WHERE role = 'owner';

-- The original setup administrator becomes Owner only while still an active
-- administrator. Otherwise ownership stays unassigned until an operator runs
-- the audited `owner:assign` command; administrator-only actions keep working.
UPDATE member members
SET role = 'owner'
FROM deployment_setup setup
WHERE setup.singleton
  AND setup.organization_id = members."organizationId"
  AND setup.admin_user_id = members."userId"
  AND members.role = 'admin';

-- What team administrators may distribute, beyond the organization defaults
-- (which are always approved). NULL means "nothing beyond the defaults".
ALTER TABLE organization_work_policies ADD COLUMN delegation JSONB;
ALTER TABLE organization_policies ADD COLUMN delegation JSONB;

-- Initialize both ceilings from the grants teams already make, so the new
-- bound does not silently remove legitimate access.
WITH work_docs AS (
  SELECT teams.organization_id, policies.policy AS doc, FALSE AS override
  FROM team_work_policies policies
  JOIN team teams ON teams.id = policies.team_id
  UNION ALL
  SELECT teams.organization_id, overrides.overrides AS doc, TRUE AS override
  FROM team_member_work_policy_overrides overrides
  JOIN team_member memberships ON memberships.id = overrides.team_member_id
  JOIN team teams ON teams.id = memberships.team_id
),
work_flags AS (
  SELECT
    organization_id,
    bool_or(COALESCE(doc->>'enabled', 'false') = 'true') AS enabled,
    bool_or(COALESCE(doc->'personalInstallations'->>'plugins', 'false') = 'true') AS plugins,
    bool_or(COALESCE(doc->'personalInstallations'->>'providers', 'false') = 'true') AS providers,
    bool_or(COALESCE(doc->'personalInstallations'->>'skills', 'false') = 'true') AS skills
  FROM work_docs
  GROUP BY organization_id
),
work_catalog AS (
  SELECT organization_id,
    jsonb_agg(DISTINCT jsonb_build_object('type', item->>'type', 'id', item->>'id')) AS items
  FROM work_docs, jsonb_array_elements(CASE WHEN jsonb_typeof(doc->'managedCatalog') = 'array' THEN doc->'managedCatalog' ELSE '[]'::jsonb END) item
  WHERE item->>'enabled' = 'true'
  GROUP BY organization_id
),
work_model_rows AS (
  SELECT organization_id, provider->>'providerId' AS provider_id, model
  FROM work_docs,
    jsonb_array_elements(CASE WHEN jsonb_typeof(doc->'providerModels') = 'array' THEN doc->'providerModels' ELSE '[]'::jsonb END) provider,
    jsonb_array_elements_text(CASE WHEN jsonb_typeof(provider->'modelIds') = 'array' THEN provider->'modelIds' ELSE '[]'::jsonb END) model
  WHERE NOT override
  UNION
  SELECT organization_id, provider->>'providerId', provider->>'modelId'
  FROM work_docs, jsonb_array_elements(CASE WHEN jsonb_typeof(doc->'providerModels') = 'array' THEN doc->'providerModels' ELSE '[]'::jsonb END) provider
  WHERE override AND provider->>'enabled' = 'true'
),
work_models AS (
  SELECT organization_id,
    jsonb_agg(jsonb_build_object('providerId', provider_id, 'modelIds', models) ORDER BY provider_id) AS providers
  FROM (
    SELECT organization_id, provider_id, jsonb_agg(DISTINCT model) AS models
    FROM work_model_rows
    GROUP BY organization_id, provider_id
  ) grouped
  GROUP BY organization_id
)
UPDATE organization_work_policies policies
SET delegation = jsonb_build_object(
  'version', 1,
  'enabled', flags.enabled,
  'personalInstallations', jsonb_build_object(
    'plugins', flags.plugins, 'providers', flags.providers, 'skills', flags.skills
  ),
  'managedCatalog', COALESCE(catalog.items, '[]'::jsonb),
  'providerModels', COALESCE(models.providers, '[]'::jsonb)
)
FROM work_flags flags
LEFT JOIN work_catalog catalog USING (organization_id)
LEFT JOIN work_models models USING (organization_id)
WHERE policies.organization_id = flags.organization_id;

WITH code_flags AS (
  SELECT organization_id,
    bool_or(plugins) AS plugins, bool_or(providers) AS providers, bool_or(skills) AS skills
  FROM (
    SELECT teams.organization_id,
      policies.allow_personal_plugins AS plugins,
      policies.allow_personal_providers AS providers,
      policies.allow_personal_skills AS skills
    FROM team_policies policies JOIN team teams ON teams.id = policies.team_id
    UNION ALL
    SELECT teams.organization_id,
      COALESCE(overrides.allow_personal_plugins, FALSE),
      COALESCE(overrides.allow_personal_providers, FALSE),
      COALESCE(overrides.allow_personal_skills, FALSE)
    FROM team_member_policy_overrides overrides
    JOIN team_member memberships ON memberships.id = overrides.team_member_id
    JOIN team teams ON teams.id = memberships.team_id
  ) flags
  GROUP BY organization_id
),
code_catalog AS (
  SELECT organization_id,
    jsonb_agg(DISTINCT jsonb_build_object('type', item_type, 'id', item_id)) AS items
  FROM (
    SELECT teams.organization_id, catalog.item_type, catalog.item_id
    FROM team_catalog_policies catalog JOIN team teams ON teams.id = catalog.team_id
    WHERE catalog.enabled
    UNION
    SELECT teams.organization_id, overrides.item_type, overrides.item_id
    FROM team_member_catalog_overrides overrides
    JOIN team_member memberships ON memberships.id = overrides.team_member_id
    JOIN team teams ON teams.id = memberships.team_id
    WHERE overrides.enabled
  ) items
  GROUP BY organization_id
),
code_orgs AS (
  SELECT organization_id FROM code_flags
  UNION
  SELECT organization_id FROM code_catalog
)
UPDATE organization_policies policies
SET delegation = jsonb_build_object(
  'version', 1,
  'personalInstallations', jsonb_build_object(
    'plugins', COALESCE(flags.plugins, FALSE),
    'providers', COALESCE(flags.providers, FALSE),
    'skills', COALESCE(flags.skills, FALSE)
  ),
  'managedCatalog', COALESCE(catalog.items, '[]'::jsonb)
)
FROM code_orgs orgs
LEFT JOIN code_flags flags USING (organization_id)
LEFT JOIN code_catalog catalog USING (organization_id)
WHERE policies.organization_id = orgs.organization_id;

-- One review report per organization in its audit log.
DO $$
DECLARE
  org RECORD;
  assigned_projects INTEGER;
BEGIN
  FOR org IN SELECT id FROM organization LOOP
    PERFORM set_config('lori.organization_id', org.id, true);
    SELECT count(*) INTO assigned_projects
    FROM cloud_work_projects
    WHERE organization_id = org.id
      AND status <> 'deleted'
      AND ((jsonb_typeof(policy->'providerModels') = 'array' AND jsonb_array_length(policy->'providerModels') > 0)
        OR (jsonb_typeof(policy->'pluginIds') = 'array' AND jsonb_array_length(policy->'pluginIds') > 0));
    INSERT INTO audit_events (id, action, organization_id, subject_type, subject_id, metadata)
    SELECT
      gen_random_uuid(),
      'permissions.migration_report',
      org.id,
      'organization',
      org.id,
      jsonb_build_object(
        'ownerAssigned', EXISTS (
          SELECT 1 FROM member WHERE "organizationId" = org.id AND role = 'owner'
        ),
        'administrators', (
          SELECT count(*) FROM member
          WHERE "organizationId" = org.id AND role IN ('owner', 'admin')
        ),
        'lapsedAdministratorInvitations', (
          SELECT count(*) FROM invitation invitations
          WHERE invitations."organizationId" = org.id
            AND invitations.status = 'pending'
            AND invitations.role = 'admin'
            AND NOT EXISTS (
              SELECT 1 FROM member inviters
              WHERE inviters."organizationId" = org.id
                AND inviters."userId" = invitations."inviterId"
                AND inviters.role = 'owner'
            )
        ),
        'workDelegation', (SELECT delegation FROM organization_work_policies WHERE organization_id = org.id),
        'codeDelegation', (SELECT delegation FROM organization_policies WHERE organization_id = org.id),
        'projectsConvertedToAssignments', assigned_projects,
        'note', 'Administrators now have full access to shared projects. Project model and plugin selections now assign those resources inside the project instead of only restricting existing grants. Review the approved team delegation in Work access and Code access.'
      );
  END LOOP;
  PERFORM set_config('lori.organization_id', '', true);
END $$;

-- Connected clients refresh policy and roles.
UPDATE organization_policies SET revision = revision + 1, updated_at = NOW();
