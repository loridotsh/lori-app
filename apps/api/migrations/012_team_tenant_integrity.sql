-- A team membership must never connect records from different organizations.
-- Application services already validate this on writes; the trigger makes the
-- tenant boundary a database invariant for imports, maintenance scripts, and
-- future write paths as well.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM team_member memberships
    JOIN team teams ON teams.id = memberships.team_id
    JOIN member members ON members.id = memberships.member_id
    WHERE teams.organization_id <> members."organizationId"
  ) THEN
    RAISE EXCEPTION
      'team_member contains a cross-organization membership; repair it before applying migration 012';
  END IF;
END
$$;

CREATE FUNCTION lori_enforce_team_member_organization()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  team_organization_id TEXT;
  member_organization_id TEXT;
BEGIN
  SELECT organization_id
  INTO team_organization_id
  FROM team
  WHERE id = NEW.team_id;

  SELECT "organizationId"
  INTO member_organization_id
  FROM member
  WHERE id = NEW.member_id;

  IF team_organization_id IS NULL OR member_organization_id IS NULL THEN
    RAISE EXCEPTION 'Team and member must exist before creating a team membership'
      USING ERRCODE = '23503';
  END IF;

  IF team_organization_id <> member_organization_id THEN
    RAISE EXCEPTION 'Team and member must belong to the same organization'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER team_member_organization_guard
BEFORE INSERT OR UPDATE OF team_id, member_id
ON team_member
FOR EACH ROW
EXECUTE FUNCTION lori_enforce_team_member_organization();
