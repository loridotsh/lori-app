-- Refresh-token replay and other token-family revocations can invalidate a
-- desktop session without changing the parent device row. Wake that exact
-- installation immediately instead of waiting for its long poll to expire.
CREATE FUNCTION notify_lori_desktop_session_revocation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  device_organization_id TEXT;
BEGIN
  SELECT organization_id
  INTO device_organization_id
  FROM devices
  WHERE id = NEW.device_id;

  IF device_organization_id IS NOT NULL THEN
    PERFORM pg_notify(
      'lori_desktop_updates',
      json_build_object(
        'kind', 'access_revoked',
        'organizationId', device_organization_id,
        'deviceId', NEW.device_id
      )::text
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER device_session_revocation_desktop_update
AFTER UPDATE OF revoked_at ON device_sessions
FOR EACH ROW
WHEN (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL)
EXECUTE FUNCTION notify_lori_desktop_session_revocation();
