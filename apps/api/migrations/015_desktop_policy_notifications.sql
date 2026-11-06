-- Deliver committed policy and revocation changes to every API replica. Each
-- replica keeps one PostgreSQL LISTEN connection and fans notifications out to
-- its authenticated desktop long-poll requests.
CREATE FUNCTION notify_lori_desktop_policy_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_notify(
    'lori_desktop_updates',
    json_build_object(
      'kind', 'policy',
      'organizationId', NEW.organization_id,
      'deviceId', '*',
      'revision', NEW.revision
    )::text
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER organization_policy_desktop_update
AFTER UPDATE OF revision ON organization_policies
FOR EACH ROW
WHEN (OLD.revision IS DISTINCT FROM NEW.revision)
EXECUTE FUNCTION notify_lori_desktop_policy_update();

CREATE FUNCTION notify_lori_desktop_revocation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_notify(
    'lori_desktop_updates',
    json_build_object(
      'kind', 'access_revoked',
      'organizationId', NEW.organization_id,
      'deviceId', NEW.id
    )::text
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER device_revocation_desktop_update
AFTER UPDATE OF revoked_at ON devices
FOR EACH ROW
WHEN (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL)
EXECUTE FUNCTION notify_lori_desktop_revocation();
