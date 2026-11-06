-- Additive project scope. NULL project_id retains the private Cloud contract.
CREATE TABLE cloud_work_projects (
 id UUID PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
 content JSONB NOT NULL, wrapped_key JSONB NOT NULL,
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived','deleted')),
 policy JSONB NOT NULL, revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
 access_revision INTEGER NOT NULL DEFAULT 1 CHECK(access_revision>0),
 created_by TEXT REFERENCES member(id) ON DELETE SET NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), purge_after TIMESTAMPTZ,
 UNIQUE(id,organization_id), CHECK((content->>'$project'='1') IS TRUE), CHECK((wrapped_key->>'$project'='1') IS TRUE),
 CHECK((status='deleted')=(purge_after IS NOT NULL))
);
CREATE INDEX cloud_projects_organization ON cloud_work_projects(organization_id,status,updated_at,id);
CREATE TABLE cloud_work_project_grants (
 id UUID PRIMARY KEY, project_id UUID NOT NULL, organization_id TEXT NOT NULL,
 member_id TEXT, team_id TEXT, role TEXT NOT NULL CHECK(role IN ('viewer','contributor','manager')),
 denied_actions JSONB NOT NULL DEFAULT '[]',
 FOREIGN KEY(project_id,organization_id) REFERENCES cloud_work_projects(id,organization_id) ON DELETE CASCADE,
 FOREIGN KEY(member_id,organization_id) REFERENCES member(id,"organizationId") ON DELETE CASCADE,
 FOREIGN KEY(team_id) REFERENCES team(id) ON DELETE CASCADE,
 CHECK((member_id IS NULL)<>(team_id IS NULL))
);
CREATE UNIQUE INDEX cloud_project_member_grant ON cloud_work_project_grants(project_id,member_id) WHERE member_id IS NOT NULL;
CREATE UNIQUE INDEX cloud_project_team_grant ON cloud_work_project_grants(project_id,team_id) WHERE team_id IS NOT NULL;
CREATE INDEX cloud_project_member_projects ON cloud_work_project_grants(organization_id,member_id,project_id);
CREATE INDEX cloud_project_team_projects ON cloud_work_project_grants(team_id,project_id);
CREATE TABLE cloud_work_project_blocks (
 project_id UUID NOT NULL, organization_id TEXT NOT NULL, member_id TEXT NOT NULL,
 PRIMARY KEY(project_id,member_id),
 FOREIGN KEY(project_id,organization_id) REFERENCES cloud_work_projects(id,organization_id) ON DELETE CASCADE,
 FOREIGN KEY(member_id,organization_id) REFERENCES member(id,"organizationId") ON DELETE CASCADE
);
CREATE INDEX cloud_project_blocks_member ON cloud_work_project_blocks(organization_id,member_id);
CREATE TABLE cloud_work_project_creation_grants (
 id UUID PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
 member_id TEXT, team_id TEXT,
 FOREIGN KEY(member_id,organization_id) REFERENCES member(id,"organizationId") ON DELETE CASCADE,
 FOREIGN KEY(team_id) REFERENCES team(id) ON DELETE CASCADE,
 CHECK((member_id IS NULL)<>(team_id IS NULL))
);
CREATE UNIQUE INDEX cloud_project_creation_member ON cloud_work_project_creation_grants(organization_id,member_id) WHERE member_id IS NOT NULL;
CREATE UNIQUE INDEX cloud_project_creation_team ON cloud_work_project_creation_grants(organization_id,team_id) WHERE team_id IS NOT NULL;
CREATE TABLE cloud_work_project_creation_settings (
 organization_id TEXT PRIMARY KEY REFERENCES organization(id) ON DELETE CASCADE, revision INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE cloud_work_project_admin_access (
 id UUID PRIMARY KEY, project_id UUID NOT NULL, organization_id TEXT NOT NULL, member_id TEXT NOT NULL,
 session_hash TEXT NOT NULL, reason JSONB NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 FOREIGN KEY(project_id,organization_id) REFERENCES cloud_work_projects(id,organization_id) ON DELETE CASCADE,
 FOREIGN KEY(member_id,organization_id) REFERENCES member(id,"organizationId") ON DELETE CASCADE,
 UNIQUE(project_id,member_id,session_hash), CHECK((reason->>'$project'='1') IS TRUE)
);
CREATE INDEX cloud_project_admin_expiry ON cloud_work_project_admin_access(expires_at);
CREATE TABLE cloud_work_project_preferences (
 project_id UUID NOT NULL REFERENCES cloud_work_projects(id) ON DELETE CASCADE,
 member_id TEXT NOT NULL REFERENCES member(id) ON DELETE CASCADE,
 pinned BOOLEAN NOT NULL DEFAULT FALSE, hidden BOOLEAN NOT NULL DEFAULT FALSE,
 approval_mode TEXT NOT NULL DEFAULT 'askMe' CHECK(approval_mode IN ('askMe','approveForMe')),
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
 PRIMARY KEY(project_id,member_id)
);
CREATE TABLE cloud_work_project_memory (
 id UUID PRIMARY KEY, project_id UUID NOT NULL, organization_id TEXT NOT NULL,
 content JSONB NOT NULL, sensitive BOOLEAN NOT NULL DEFAULT FALSE, revision INTEGER NOT NULL DEFAULT 1,
 author_id TEXT REFERENCES member(id) ON DELETE SET NULL,
 source_message_id UUID REFERENCES cloud_work_messages(id) ON DELETE SET NULL,
 provenance TEXT NOT NULL CHECK(provenance IN ('manual','approved_tool')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 FOREIGN KEY(project_id,organization_id) REFERENCES cloud_work_projects(id,organization_id) ON DELETE CASCADE,
 CHECK((content->>'$project'='1') IS TRUE)
);
CREATE INDEX cloud_project_memory_scope ON cloud_work_project_memory(project_id,updated_at,id);
CREATE TABLE cloud_work_project_search (
 project_id UUID PRIMARY KEY REFERENCES cloud_work_projects(id) ON DELETE CASCADE,
 revision BIGINT NOT NULL DEFAULT 0, indexed_revision BIGINT NOT NULL DEFAULT -1,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','ready','limited','failed')),
 snapshot JSONB, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), CHECK(snapshot IS NULL OR (snapshot->>'$project'='1') IS TRUE)
);

-- A project root is an internal file anchor, never a user conversation.
ALTER TABLE cloud_work_conversations ADD COLUMN project_id UUID,
 ADD COLUMN creation_fingerprint TEXT,
 ADD COLUMN is_project_root BOOLEAN NOT NULL DEFAULT FALSE,
 ADD COLUMN created_by TEXT REFERENCES member(id) ON DELETE SET NULL,
 ALTER COLUMN member_id DROP NOT NULL,
 ADD CONSTRAINT cloud_conversation_scope CHECK((project_id IS NULL)=(member_id IS NOT NULL)),
 ADD CONSTRAINT cloud_project_root_identity CHECK(NOT is_project_root OR id=project_id),
 ADD CONSTRAINT cloud_conversation_project FOREIGN KEY(project_id,organization_id) REFERENCES cloud_work_projects(id,organization_id) ON DELETE CASCADE,
 ADD CONSTRAINT cloud_conversation_tenant UNIQUE(id,organization_id);
CREATE INDEX cloud_project_conversations ON cloud_work_conversations(project_id,updated_at,id) WHERE project_id IS NOT NULL AND NOT is_project_root;
ALTER TABLE cloud_work_conversations DROP CONSTRAINT cloud_work_conversations_title_check;
ALTER TABLE cloud_work_conversations ADD CHECK((project_id IS NULL AND char_length(title) BETWEEN 1 AND 200) OR (project_id IS NOT NULL AND title LIKE 'lori-project:1:%' AND octet_length(title)<=4096));
DO $$ DECLARE r RECORD; BEGIN
 FOR r IN SELECT conname FROM pg_constraint WHERE conrelid='cloud_work_runs'::regclass AND confrelid='cloud_work_conversations'::regclass AND contype='f'
 LOOP EXECUTE format('ALTER TABLE cloud_work_runs DROP CONSTRAINT %I',r.conname); END LOOP;
END $$;

ALTER TABLE cloud_work_plugin_connections ADD COLUMN project_id UUID REFERENCES cloud_work_projects(id) ON DELETE CASCADE,
 ALTER COLUMN member_id DROP NOT NULL,
 ADD CHECK((project_id IS NULL)=(member_id IS NOT NULL)),
 ADD FOREIGN KEY(project_id,organization_id) REFERENCES cloud_work_projects(id,organization_id) ON DELETE CASCADE;
CREATE UNIQUE INDEX cloud_project_plugin ON cloud_work_plugin_connections(organization_id,project_id,plugin_id) WHERE project_id IS NOT NULL;
ALTER TABLE cloud_work_plugin_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_work_plugin_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY project_scope ON cloud_work_plugin_connections USING(project_id IS NULL OR project_id::text=nullif(current_setting('lori.project_id',true),'')) WITH CHECK(project_id IS NULL OR project_id::text=nullif(current_setting('lori.project_id',true),''));
ALTER TABLE cloud_work_plugin_authorizations ADD COLUMN project_id UUID REFERENCES cloud_work_projects(id) ON DELETE CASCADE;
CREATE TABLE cloud_work_project_skill_preferences (
 project_id UUID NOT NULL REFERENCES cloud_work_projects(id) ON DELETE CASCADE,
 skill_id TEXT NOT NULL, enabled BOOLEAN NOT NULL, PRIMARY KEY(project_id,skill_id)
);
ALTER TABLE cloud_work_project_skill_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_work_project_skill_preferences FORCE ROW LEVEL SECURITY;
CREATE POLICY project_scope ON cloud_work_project_skill_preferences USING(project_id::text=nullif(current_setting('lori.project_id',true),'')) WITH CHECK(project_id::text=nullif(current_setting('lori.project_id',true),''));
ALTER TABLE cloud_work_runs ADD COLUMN project_id UUID REFERENCES cloud_work_projects(id) ON DELETE CASCADE,
 ADD CONSTRAINT cloud_run_conversation_tenant FOREIGN KEY(conversation_id,organization_id) REFERENCES cloud_work_conversations(id,organization_id) ON DELETE CASCADE;
CREATE INDEX cloud_project_active_runs ON cloud_work_runs(project_id,status) WHERE project_id IS NOT NULL;
ALTER TABLE cloud_work_messages ADD COLUMN author_id TEXT REFERENCES member(id) ON DELETE SET NULL,
 ADD COLUMN content_bytes INTEGER NOT NULL DEFAULT 0 CHECK(content_bytes BETWEEN 0 AND 1048576);
ALTER TABLE cloud_work_approvals ADD COLUMN decided_by TEXT REFERENCES member(id) ON DELETE SET NULL;

-- Derived scope is always assigned from the parent, never accepted from a caller.
CREATE FUNCTION lori_cloud_inherit_project() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE parent_project UUID; parent_org TEXT; parent_member TEXT;
BEGIN
 IF TG_TABLE_NAME='cloud_work_runs' THEN
   SELECT project_id,organization_id,member_id INTO parent_project,parent_org,parent_member FROM cloud_work_conversations WHERE id=NEW.conversation_id;
   IF parent_org IS DISTINCT FROM NEW.organization_id OR (parent_project IS NULL AND parent_member IS DISTINCT FROM NEW.member_id) THEN
     RAISE EXCEPTION 'Cloud run scope mismatch' USING ERRCODE='23514';
   END IF;
 ELSIF TG_TABLE_NAME IN ('cloud_work_messages','cloud_work_files') THEN
   SELECT project_id INTO parent_project FROM cloud_work_conversations WHERE id=NEW.conversation_id;
 ELSIF TG_TABLE_NAME IN ('cloud_work_rounds','cloud_work_events','cloud_work_tool_invocations','cloud_work_approvals') THEN
   SELECT project_id INTO parent_project FROM cloud_work_runs WHERE id=NEW.run_id;
 ELSIF TG_TABLE_NAME IN ('cloud_work_file_versions','cloud_work_file_previews') THEN
   SELECT project_id INTO parent_project FROM cloud_work_files WHERE id=NEW.file_id;
 ELSIF TG_TABLE_NAME='cloud_work_staged_files' THEN
   SELECT project_id INTO parent_project FROM cloud_work_tool_invocations WHERE id=NEW.invocation_id;
 END IF;
 IF NEW.project_id IS NOT NULL AND NEW.project_id IS DISTINCT FROM parent_project THEN
   RAISE EXCEPTION 'Cloud child scope mismatch' USING ERRCODE='23514';
 END IF;
 NEW.project_id=parent_project;
 RETURN NEW;
END $$;
DO $$ DECLARE t TEXT; BEGIN
 FOREACH t IN ARRAY ARRAY['cloud_work_messages','cloud_work_files','cloud_work_file_versions','cloud_work_rounds','cloud_work_events','cloud_work_tool_invocations','cloud_work_approvals','cloud_work_staged_files','cloud_work_file_previews'] LOOP
   EXECUTE format('ALTER TABLE %I ADD COLUMN project_id UUID REFERENCES cloud_work_projects(id) ON DELETE CASCADE',t);
   EXECUTE format('CREATE INDEX %I ON %I(project_id) WHERE project_id IS NOT NULL',t||'_project',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['cloud_work_runs','cloud_work_messages','cloud_work_files','cloud_work_file_versions','cloud_work_rounds','cloud_work_events','cloud_work_tool_invocations','cloud_work_approvals','cloud_work_staged_files','cloud_work_file_previews'] LOOP
   EXECUTE format('CREATE TRIGGER cloud_inherit_project BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION lori_cloud_inherit_project()',t);
 END LOOP;
END $$;
ALTER TABLE cloud_work_mutations ADD COLUMN project_id UUID REFERENCES cloud_work_projects(id) ON DELETE CASCADE;
ALTER TABLE cloud_work_tool_invocations ADD COLUMN arguments_hash TEXT;
ALTER TABLE cloud_work_staged_files ADD COLUMN path_key TEXT;
CREATE UNIQUE INDEX cloud_project_staged_path ON cloud_work_staged_files(invocation_id,path_key) WHERE path_key IS NOT NULL;
ALTER TABLE cloud_work_files ADD COLUMN path_key TEXT, ADD COLUMN path_prefixes TEXT[];
ALTER TABLE cloud_work_files DROP CONSTRAINT cloud_work_files_path_check;
ALTER TABLE cloud_work_files ADD CHECK((project_id IS NULL AND length(path) BETWEEN 1 AND 240) OR (project_id IS NOT NULL AND path LIKE 'lori-project:1:%'));
CREATE UNIQUE INDEX cloud_project_file_path ON cloud_work_files(project_id,path_key) WHERE project_id IS NOT NULL;

-- An extra authenticated storage envelope fits without relaxing API content limits.
ALTER TABLE cloud_work_messages DROP CONSTRAINT cloud_work_messages_text_check;
ALTER TABLE cloud_work_messages ADD CHECK(octet_length(text)<=2097152);
ALTER TABLE cloud_work_runs DROP CONSTRAINT cloud_work_runs_assistant_text_check;
ALTER TABLE cloud_work_runs ADD CHECK(octet_length(assistant_text)<=2097152);

CREATE FUNCTION lori_project_context_matches(project UUID) RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
 SELECT project::text = nullif(current_setting('lori.project_id',true),'')
$$;
DO $$ DECLARE t TEXT; BEGIN
 FOREACH t IN ARRAY ARRAY['cloud_work_conversations','cloud_work_runs','cloud_work_messages','cloud_work_files','cloud_work_file_versions','cloud_work_rounds','cloud_work_events','cloud_work_tool_invocations','cloud_work_approvals','cloud_work_staged_files','cloud_work_file_previews','cloud_work_mutations'] LOOP
   EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
   EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
   EXECUTE format('CREATE POLICY project_scope ON %I USING (project_id IS NULL OR lori_project_context_matches(project_id)) WITH CHECK (project_id IS NULL OR lori_project_context_matches(project_id))',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['cloud_work_project_memory','cloud_work_project_search','cloud_work_project_admin_access','cloud_work_project_preferences'] LOOP
   EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
   EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
   EXECUTE format('CREATE POLICY project_scope ON %I USING (lori_project_context_matches(project_id)) WITH CHECK (lori_project_context_matches(project_id))',t);
 END LOOP;
END $$;

-- Prevent a grant from attaching a team belonging to another organization.
CREATE FUNCTION lori_cloud_project_team_tenant() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.team_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM team WHERE id=NEW.team_id AND organization_id=NEW.organization_id) THEN
   RAISE EXCEPTION 'Project team scope mismatch' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cloud_project_team_tenant BEFORE INSERT OR UPDATE ON cloud_work_project_grants FOR EACH ROW EXECUTE FUNCTION lori_cloud_project_team_tenant();
CREATE TRIGGER cloud_project_creation_team_tenant BEFORE INSERT OR UPDATE ON cloud_work_project_creation_grants FOR EACH ROW EXECUTE FUNCTION lori_cloud_project_team_tenant();

-- Content-free directories allow authorization BEFORE an RLS-protected read.
CREATE TABLE cloud_work_project_resource_scopes (
 kind TEXT NOT NULL CHECK(kind IN ('conversation','run','file')),
 resource_id UUID NOT NULL, project_id UUID NOT NULL, organization_id TEXT NOT NULL,
 PRIMARY KEY(kind,resource_id),
 FOREIGN KEY(project_id,organization_id) REFERENCES cloud_work_projects(id,organization_id) ON DELETE CASCADE
);
CREATE INDEX cloud_project_resource_parent ON cloud_work_project_resource_scopes(project_id);
CREATE TABLE cloud_work_project_run_queue (
 id UUID PRIMARY KEY REFERENCES cloud_work_runs(id) ON DELETE CASCADE,
 organization_id TEXT NOT NULL, project_id UUID NOT NULL, member_id TEXT NOT NULL,
 status TEXT NOT NULL, lease_until TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL,
 FOREIGN KEY(project_id,organization_id) REFERENCES cloud_work_projects(id,organization_id) ON DELETE CASCADE
);
CREATE INDEX cloud_project_queue_state ON cloud_work_project_run_queue(status,created_at);
CREATE FUNCTION lori_cloud_project_directory() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE k TEXT;
BEGIN
 k=CASE TG_TABLE_NAME WHEN 'cloud_work_conversations' THEN 'conversation' WHEN 'cloud_work_runs' THEN 'run' ELSE 'file' END;
 IF TG_OP='DELETE' THEN DELETE FROM cloud_work_project_resource_scopes WHERE kind=k AND resource_id=OLD.id; RETURN OLD; END IF;
 IF NEW.project_id IS NOT NULL THEN
   INSERT INTO cloud_work_project_resource_scopes(kind,resource_id,project_id,organization_id)
   SELECT k,NEW.id,p.id,p.organization_id FROM cloud_work_projects p WHERE p.id=NEW.project_id
   ON CONFLICT(kind,resource_id) DO UPDATE SET project_id=EXCLUDED.project_id,organization_id=EXCLUDED.organization_id;
   IF TG_TABLE_NAME='cloud_work_runs' THEN
     INSERT INTO cloud_work_project_run_queue(id,organization_id,project_id,member_id,status,lease_until,created_at)
     VALUES(NEW.id,NEW.organization_id,NEW.project_id,NEW.member_id,NEW.status,NEW.lease_until,NEW.created_at)
     ON CONFLICT(id) DO UPDATE SET status=EXCLUDED.status,lease_until=EXCLUDED.lease_until;
   END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cloud_project_directory AFTER INSERT OR UPDATE OR DELETE ON cloud_work_conversations FOR EACH ROW EXECUTE FUNCTION lori_cloud_project_directory();
CREATE TRIGGER cloud_project_directory AFTER INSERT OR UPDATE OR DELETE ON cloud_work_runs FOR EACH ROW EXECUTE FUNCTION lori_cloud_project_directory();
CREATE TRIGGER cloud_project_directory AFTER INSERT OR UPDATE OR DELETE ON cloud_work_files FOR EACH ROW EXECUTE FUNCTION lori_cloud_project_directory();

CREATE TABLE cloud_work_project_blob_references (
 storage_key UUID PRIMARY KEY, project_id UUID NOT NULL REFERENCES cloud_work_projects(id) ON DELETE CASCADE
);
CREATE FUNCTION lori_cloud_project_blob_reference() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN DELETE FROM cloud_work_project_blob_references WHERE storage_key=OLD.storage_key; RETURN OLD; END IF;
 IF NEW.project_id IS NOT NULL THEN INSERT INTO cloud_work_project_blob_references(storage_key,project_id) VALUES(NEW.storage_key,NEW.project_id) ON CONFLICT DO NOTHING; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cloud_project_blob_reference AFTER INSERT OR DELETE ON cloud_work_file_versions FOR EACH ROW EXECUTE FUNCTION lori_cloud_project_blob_reference();
CREATE TRIGGER cloud_project_blob_reference AFTER INSERT OR DELETE ON cloud_work_staged_files FOR EACH ROW EXECUTE FUNCTION lori_cloud_project_blob_reference();

ALTER TABLE cloud_work_file_previews DROP CONSTRAINT cloud_work_file_previews_image_check;
ALTER TABLE cloud_work_file_previews ADD CHECK(octet_length(image)<=6291456);
CREATE TABLE cloud_work_project_preview_queue (
 id UUID PRIMARY KEY REFERENCES cloud_work_file_previews(id) ON DELETE CASCADE,
 project_id UUID NOT NULL REFERENCES cloud_work_projects(id) ON DELETE CASCADE,
 organization_id TEXT NOT NULL, status TEXT NOT NULL, priority INTEGER NOT NULL,
 created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL, image_bytes INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX cloud_project_preview_claim ON cloud_work_project_preview_queue(status,priority,created_at);
CREATE FUNCTION lori_cloud_project_preview_directory() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.project_id IS NOT NULL THEN
   INSERT INTO cloud_work_project_preview_queue(id,project_id,organization_id,status,priority,created_at,updated_at,image_bytes)
   SELECT NEW.id,NEW.project_id,p.organization_id,NEW.status,NEW.priority,NEW.created_at,NEW.updated_at,COALESCE(octet_length(NEW.image),0) FROM cloud_work_projects p WHERE p.id=NEW.project_id
   ON CONFLICT(id) DO UPDATE SET status=EXCLUDED.status,priority=EXCLUDED.priority,created_at=EXCLUDED.created_at,updated_at=EXCLUDED.updated_at,image_bytes=EXCLUDED.image_bytes;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cloud_project_preview_directory AFTER INSERT OR UPDATE ON cloud_work_file_previews FOR EACH ROW EXECUTE FUNCTION lori_cloud_project_preview_directory();

CREATE TABLE cloud_work_project_maintenance (
 project_id UUID PRIMARY KEY REFERENCES cloud_work_projects(id) ON DELETE CASCADE,
 organization_id TEXT NOT NULL, status TEXT NOT NULL, purge_after TIMESTAMPTZ,
 last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), checked_at TIMESTAMPTZ
);
CREATE FUNCTION lori_cloud_project_maintenance_directory() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO cloud_work_project_maintenance(project_id,organization_id,status,purge_after)
 VALUES(NEW.id,NEW.organization_id,NEW.status,NEW.purge_after)
 ON CONFLICT(project_id) DO UPDATE SET status=EXCLUDED.status,purge_after=EXCLUDED.purge_after;
 RETURN NEW;
END $$;
CREATE TRIGGER cloud_project_maintenance_directory AFTER INSERT OR UPDATE ON cloud_work_projects FOR EACH ROW EXECUTE FUNCTION lori_cloud_project_maintenance_directory();

DO $$ DECLARE t TEXT; BEGIN
 FOREACH t IN ARRAY ARRAY['cloud_work_projects','cloud_work_project_grants','cloud_work_project_blocks','cloud_work_project_creation_grants','cloud_work_project_resource_scopes'] LOOP
   EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
   EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
   EXECUTE format('CREATE POLICY project_organization ON %I USING (organization_id=nullif(current_setting(''lori.organization_id'',true),'''')) WITH CHECK (organization_id=nullif(current_setting(''lori.organization_id'',true),''''))',t);
 END LOOP;
END $$;

-- The runtime cannot create tables. Only this fixed-purpose partition routine
-- executes as the migration owner; bind its search path to the installed schema.
ALTER FUNCTION ensure_usage_analytics_partition(DATE) SECURITY DEFINER;
DO $$ BEGIN
 EXECUTE format('ALTER FUNCTION ensure_usage_analytics_partition(DATE) SET search_path TO %I, pg_temp', current_schema());
END $$;
REVOKE ALL ON FUNCTION ensure_usage_analytics_partition(DATE) FROM PUBLIC;

-- Detect a replaced/lost mounted keyring before admitting new project writes.
CREATE TABLE cloud_work_project_key_check (
 singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton),
 wrapped_key JSONB NOT NULL CHECK((wrapped_key->>'$project'='1') IS TRUE)
);

-- Reject accidental plaintext persistence even when an application call site
-- forgets its codec. Empty run buffers and uncompleted round arrays carry no text.
CREATE FUNCTION lori_project_sealed(value JSONB) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$ SELECT (value->>'$project'='1') IS TRUE $$;
ALTER TABLE cloud_work_messages ADD CHECK(project_id IS NULL OR text LIKE 'lori-project:1:%');
ALTER TABLE cloud_work_runs ADD CHECK(project_id IS NULL OR assistant_text='' OR assistant_text LIKE 'lori-project:1:%');
ALTER TABLE cloud_work_events ADD CHECK(project_id IS NULL OR lori_project_sealed(data));
ALTER TABLE cloud_work_mutations ADD CHECK(project_id IS NULL OR lori_project_sealed(response));
ALTER TABLE cloud_work_rounds ADD CHECK(project_id IS NULL OR
 ( (assistant IS NULL OR lori_project_sealed(assistant)) AND
   (tool_calls='[]'::jsonb OR lori_project_sealed(tool_calls)) ));
ALTER TABLE cloud_work_tool_invocations ADD CHECK(project_id IS NULL OR
 (lori_project_sealed(arguments) AND
 (execution IS NULL OR lori_project_sealed(execution)) AND
 (output IS NULL OR lori_project_sealed(output)) AND
 (model_output IS NULL OR lori_project_sealed(model_output))));
ALTER TABLE cloud_work_approvals ADD CHECK(project_id IS NULL OR
 ((summary IS NULL OR summary LIKE 'lori-project:1:%') AND
 (files IS NULL OR lori_project_sealed(files))));
ALTER TABLE cloud_work_staged_files ADD CHECK(project_id IS NULL OR path LIKE 'lori-project:1:%');

-- Scope is fixed for a resource's lifetime; this release has no move/import API.
CREATE FUNCTION lori_cloud_project_scope_immutable() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.project_id IS DISTINCT FROM NEW.project_id THEN
   RAISE EXCEPTION 'Project resource scope is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE t TEXT; BEGIN
 FOREACH t IN ARRAY ARRAY['cloud_work_conversations','cloud_work_runs','cloud_work_messages','cloud_work_files','cloud_work_file_versions','cloud_work_rounds','cloud_work_events','cloud_work_tool_invocations','cloud_work_approvals','cloud_work_staged_files','cloud_work_file_previews','cloud_work_mutations','cloud_work_plugin_connections'] LOOP
   EXECUTE format('CREATE TRIGGER cloud_project_scope_immutable BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION lori_cloud_project_scope_immutable()',t);
 END LOOP;
END $$;
