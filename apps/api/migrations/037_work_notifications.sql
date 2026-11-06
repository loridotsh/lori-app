-- Content-free attention events; committed atomically with the run/approval.
CREATE TABLE cloud_work_notifications (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 organization_id TEXT NOT NULL,
 member_id TEXT NOT NULL,
 run_id UUID NOT NULL REFERENCES cloud_work_runs(id) ON DELETE CASCADE,
 conversation_id UUID NOT NULL,
 project_id UUID REFERENCES cloud_work_projects(id) ON DELETE CASCADE,
 approval_id UUID REFERENCES cloud_work_approvals(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('completed','failed','interrupted','approval')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(member_id,organization_id) REFERENCES member(id,"organizationId") ON DELETE CASCADE
);
CREATE INDEX cloud_notifications_member ON cloud_work_notifications(organization_id,member_id,id DESC);
CREATE INDEX cloud_notifications_expiry ON cloud_work_notifications(organization_id,member_id,created_at);
CREATE INDEX cloud_notifications_run ON cloud_work_notifications(run_id);
CREATE INDEX cloud_notifications_project ON cloud_work_notifications(project_id);
CREATE INDEX cloud_notifications_approval ON cloud_work_notifications(approval_id);
ALTER TABLE cloud_work_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_work_notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY notification_organization ON cloud_work_notifications
 USING(organization_id=nullif(current_setting('lori.organization_id',true),''))
 WITH CHECK(organization_id=nullif(current_setting('lori.organization_id',true),''));
CREATE FUNCTION lori_work_notification() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE previous_scope TEXT; event_organization TEXT;
BEGIN
 previous_scope=current_setting('lori.organization_id',true);
 IF TG_TABLE_NAME='cloud_work_runs' THEN event_organization=NEW.organization_id;
 ELSE SELECT organization_id INTO event_organization FROM cloud_work_runs r WHERE id=NEW.run_id AND EXISTS(SELECT 1 FROM member m WHERE m.id=r.member_id AND m."organizationId"=r.organization_id); END IF;
 -- Maintenance can settle private runs without a member request context. The
 -- trigger derives the organization from the row, and restores the caller scope.
 PERFORM set_config('lori.organization_id',COALESCE(event_organization,''),true);
 IF TG_TABLE_NAME='cloud_work_runs' THEN
   IF NEW.status IN ('completed','failed','interrupted') AND NEW.status IS DISTINCT FROM OLD.status THEN
     INSERT INTO cloud_work_notifications(organization_id,member_id,run_id,conversation_id,project_id,kind)
       SELECT NEW.organization_id,NEW.member_id,NEW.id,NEW.conversation_id,NEW.project_id,NEW.status
       WHERE EXISTS(SELECT 1 FROM member WHERE id=NEW.member_id AND "organizationId"=NEW.organization_id);
   END IF;
 ELSE
   IF NEW.status='pending' THEN
     INSERT INTO cloud_work_notifications(organization_id,member_id,run_id,conversation_id,project_id,approval_id,kind)
       SELECT organization_id,member_id,id,conversation_id,project_id,NEW.id,'approval' FROM cloud_work_runs r WHERE id=NEW.run_id AND EXISTS(SELECT 1 FROM member m WHERE m.id=r.member_id AND m."organizationId"=r.organization_id);
   END IF;
 END IF;
 PERFORM set_config('lori.organization_id',COALESCE(previous_scope,''),true);
 RETURN NEW;
END $$;
CREATE TRIGGER cloud_run_notification AFTER UPDATE OF status ON cloud_work_runs FOR EACH ROW EXECUTE FUNCTION lori_work_notification();
CREATE TRIGGER cloud_approval_notification AFTER INSERT ON cloud_work_approvals FOR EACH ROW EXECUTE FUNCTION lori_work_notification();
