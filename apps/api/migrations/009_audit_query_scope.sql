ALTER TABLE audit_events
  ADD COLUMN organization_id TEXT REFERENCES organization(id) ON DELETE CASCADE;

UPDATE audit_events events
SET organization_id = members."organizationId"
FROM member members
WHERE members."userId" = events.actor_user_id
  AND events.organization_id IS NULL;

CREATE INDEX audit_events_organization_created_at_idx
  ON audit_events (organization_id, created_at DESC, id DESC);
CREATE INDEX audit_events_organization_action_idx
  ON audit_events (organization_id, action, created_at DESC);
CREATE INDEX audit_events_organization_subject_idx
  ON audit_events (organization_id, subject_type, subject_id, created_at DESC);
