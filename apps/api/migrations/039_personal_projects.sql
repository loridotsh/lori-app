-- Personal projects: owner-only folders over a member's private Cloud conversations.
-- They are a separate layer from team workspaces (cloud_work_projects). A filed
-- conversation keeps its id, transcript and owner; only personal_project_id moves.

-- Organization policy. An absent row means defaults: only administrators may create.
CREATE TABLE cloud_work_personal_project_settings (
 organization_id TEXT PRIMARY KEY REFERENCES organization(id) ON DELETE CASCADE,
 allow_all BOOLEAN NOT NULL DEFAULT FALSE,
 max_per_member INTEGER CHECK(max_per_member IS NULL OR max_per_member BETWEEN 1 AND 1000),
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0)
);
CREATE TABLE cloud_work_personal_project_creation_grants (
 id UUID PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
 member_id TEXT, team_id TEXT,
 FOREIGN KEY(member_id,organization_id) REFERENCES member(id,"organizationId") ON DELETE CASCADE,
 FOREIGN KEY(team_id) REFERENCES team(id) ON DELETE CASCADE,
 CHECK((member_id IS NULL)<>(team_id IS NULL))
);
CREATE UNIQUE INDEX cloud_personal_creation_member ON cloud_work_personal_project_creation_grants(organization_id,member_id) WHERE member_id IS NOT NULL;
CREATE UNIQUE INDEX cloud_personal_creation_team ON cloud_work_personal_project_creation_grants(organization_id,team_id) WHERE team_id IS NOT NULL;
CREATE TABLE cloud_work_personal_project_creation_blocks (
 organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
 member_id TEXT NOT NULL, PRIMARY KEY(organization_id,member_id),
 FOREIGN KEY(member_id,organization_id) REFERENCES member(id,"organizationId") ON DELETE CASCADE
);
-- A grant may not attach a team of another organization.
CREATE TRIGGER cloud_personal_creation_team_tenant BEFORE INSERT OR UPDATE ON cloud_work_personal_project_creation_grants
 FOR EACH ROW EXECUTE FUNCTION lori_cloud_project_team_tenant();

CREATE TABLE cloud_work_personal_projects (
 id UUID PRIMARY KEY,
 organization_id TEXT NOT NULL, member_id TEXT NOT NULL,
 name TEXT NOT NULL CHECK(char_length(name) BETWEEN 1 AND 100 AND name=btrim(name)),
 description TEXT NOT NULL DEFAULT '' CHECK(char_length(description)<=2000),
 instructions TEXT NOT NULL DEFAULT '' CHECK(octet_length(instructions)<=48000),
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived','deleted')),
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 archived_at TIMESTAMPTZ, deleted_at TIMESTAMPTZ, purge_after TIMESTAMPTZ,
 UNIQUE(id,organization_id,member_id),
 FOREIGN KEY(member_id,organization_id) REFERENCES member(id,"organizationId") ON DELETE CASCADE,
 CHECK((status='deleted')=(deleted_at IS NOT NULL AND purge_after IS NOT NULL)),
 CHECK(status<>'archived' OR archived_at IS NOT NULL)
);
CREATE INDEX cloud_personal_projects_owner ON cloud_work_personal_projects(organization_id,member_id,status,updated_at DESC,id DESC);
CREATE INDEX cloud_personal_projects_purge ON cloud_work_personal_projects(purge_after) WHERE status='deleted';

-- Ownership is fixed for the life of a project.
CREATE FUNCTION lori_personal_project_owner_immutable() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.member_id IS DISTINCT FROM OLD.member_id THEN
   RAISE EXCEPTION 'Personal project ownership is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cloud_personal_project_owner_immutable BEFORE UPDATE ON cloud_work_personal_projects
 FOR EACH ROW EXECUTE FUNCTION lori_personal_project_owner_immutable();

-- A private conversation may sit in one of its owner's personal projects, never
-- in a team workspace as well, and never as a project's internal file root.
ALTER TABLE cloud_work_conversations ADD COLUMN personal_project_id UUID,
 ADD CONSTRAINT cloud_conversation_personal_exclusive CHECK(personal_project_id IS NULL OR (project_id IS NULL AND member_id IS NOT NULL AND NOT is_project_root)),
 ADD CONSTRAINT cloud_conversation_personal_project FOREIGN KEY(personal_project_id,organization_id,member_id)
   REFERENCES cloud_work_personal_projects(id,organization_id,member_id) ON DELETE CASCADE;
CREATE INDEX cloud_personal_project_conversations ON cloud_work_conversations(personal_project_id,updated_at DESC,id DESC) WHERE personal_project_id IS NOT NULL;

-- Reference files: project-level knowledge, never a shared editable working directory.
CREATE TABLE cloud_work_personal_project_references (
 id UUID PRIMARY KEY,
 personal_project_id UUID NOT NULL, organization_id TEXT NOT NULL, member_id TEXT NOT NULL,
 name TEXT NOT NULL CHECK(char_length(name) BETWEEN 1 AND 200 AND name !~ '[\\/[:cntrl:]]'),
 mime_type TEXT NOT NULL,
 size_bytes INTEGER NOT NULL CHECK(size_bytes BETWEEN 0 AND 20971520), sha256 TEXT NOT NULL,
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(id,personal_project_id),
 FOREIGN KEY(personal_project_id,organization_id,member_id) REFERENCES cloud_work_personal_projects(id,organization_id,member_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX cloud_personal_reference_name ON cloud_work_personal_project_references(personal_project_id,lower(name));
CREATE INDEX cloud_personal_reference_list ON cloud_work_personal_project_references(personal_project_id,name,id);
CREATE TABLE cloud_work_personal_project_reference_versions (
 reference_id UUID NOT NULL, personal_project_id UUID NOT NULL, organization_id TEXT NOT NULL, member_id TEXT NOT NULL,
 version INTEGER NOT NULL CHECK(version>0), storage_key UUID NOT NULL UNIQUE,
 size_bytes INTEGER NOT NULL CHECK(size_bytes BETWEEN 0 AND 20971520), sha256 TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(reference_id,version),
 FOREIGN KEY(reference_id,personal_project_id) REFERENCES cloud_work_personal_project_references(id,personal_project_id) ON DELETE CASCADE,
 FOREIGN KEY(personal_project_id,organization_id,member_id) REFERENCES cloud_work_personal_projects(id,organization_id,member_id) ON DELETE CASCADE
);
CREATE INDEX cloud_personal_reference_versions_project ON cloud_work_personal_project_reference_versions(personal_project_id,reference_id);
-- A stored version is evidence for the hash a chat was given: it is replaced by a new version, never edited.
CREATE FUNCTION lori_personal_reference_version_immutable() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Personal project reference versions are immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER cloud_personal_reference_version_immutable BEFORE UPDATE ON cloud_work_personal_project_reference_versions
 FOR EACH ROW EXECUTE FUNCTION lori_personal_reference_version_immutable();

-- Content-free blob directory, readable without owner scope, so storage cleanup
-- can tell a referenced blob from an orphan without ever reading personal rows.
CREATE TABLE cloud_work_personal_blob_references (storage_key UUID PRIMARY KEY);
CREATE FUNCTION lori_personal_blob_reference() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN DELETE FROM cloud_work_personal_blob_references WHERE storage_key=OLD.storage_key; RETURN OLD; END IF;
 INSERT INTO cloud_work_personal_blob_references(storage_key) VALUES(NEW.storage_key) ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;
CREATE TRIGGER cloud_personal_blob_reference AFTER INSERT OR DELETE ON cloud_work_personal_project_reference_versions
 FOR EACH ROW EXECUTE FUNCTION lori_personal_blob_reference();

-- The page-image cache serves working files and references. A reference id is
-- unique, so the cache keeps one key and its rows leave with their source.
DO $$ DECLARE r RECORD; BEGIN
 FOR r IN SELECT conname FROM pg_constraint WHERE conrelid='cloud_work_file_previews'::regclass AND contype='f' AND confrelid='cloud_work_files'::regclass
 LOOP EXECUTE format('ALTER TABLE cloud_work_file_previews DROP CONSTRAINT %I',r.conname); END LOOP;
END $$;
CREATE FUNCTION lori_cloud_preview_source_removed() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN DELETE FROM cloud_work_file_previews WHERE file_id=OLD.id; RETURN OLD; END $$;
CREATE TRIGGER cloud_preview_source_removed AFTER DELETE ON cloud_work_files FOR EACH ROW EXECUTE FUNCTION lori_cloud_preview_source_removed();
CREATE TRIGGER cloud_preview_source_removed AFTER DELETE ON cloud_work_personal_project_references FOR EACH ROW EXECUTE FUNCTION lori_cloud_preview_source_removed();

-- What the preview workers read: every file a page image can be rendered from.
-- References are visible here only to a transaction holding the internal scope.
CREATE VIEW cloud_work_preview_sources AS
 SELECT id,path,sha256 FROM cloud_work_files
 UNION ALL
 SELECT id,name AS path,sha256 FROM cloud_work_personal_project_references;
CREATE VIEW cloud_work_preview_source_versions AS
 SELECT file_id,version,storage_key FROM cloud_work_file_versions
 UNION ALL
 SELECT reference_id AS file_id,version,storage_key FROM cloud_work_personal_project_reference_versions;

-- Idempotency for creation, moves and lifecycle operations.
CREATE TABLE cloud_work_personal_project_requests (
 organization_id TEXT NOT NULL, member_id TEXT NOT NULL, request_id UUID NOT NULL,
 operation TEXT NOT NULL CHECK(operation IN ('create','update','lifecycle','move','conversation','reference')),
 fingerprint TEXT NOT NULL, response JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(organization_id,member_id,request_id),
 FOREIGN KEY(member_id,organization_id) REFERENCES member(id,"organizationId") ON DELETE CASCADE
);
CREATE INDEX cloud_personal_requests_age ON cloud_work_personal_project_requests(created_at);

-- Row-level security. Identity is transaction-local and set only from a verified
-- session (lori.member_id) or verified worker authority (lori.personal_scope =
-- 'internal'), never from a request body.
CREATE FUNCTION lori_personal_owner_matches(org TEXT, owner TEXT) RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
 SELECT current_setting('lori.personal_scope',true)='internal'
  OR (org=nullif(current_setting('lori.organization_id',true),'') AND owner=nullif(current_setting('lori.member_id',true),''))
$$;
DO $$ DECLARE t TEXT; BEGIN
 FOREACH t IN ARRAY ARRAY['cloud_work_personal_projects','cloud_work_personal_project_references','cloud_work_personal_project_reference_versions','cloud_work_personal_project_requests'] LOOP
   EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
   EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
   EXECUTE format('CREATE POLICY personal_owner ON %I USING (lori_personal_owner_matches(organization_id,member_id)) WITH CHECK (lori_personal_owner_matches(organization_id,member_id))',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['cloud_work_personal_project_settings','cloud_work_personal_project_creation_grants','cloud_work_personal_project_creation_blocks'] LOOP
   EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
   EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
   EXECUTE format('CREATE POLICY personal_organization ON %I USING (current_setting(''lori.personal_scope'',true)=''internal'' OR organization_id=nullif(current_setting(''lori.organization_id'',true),'''')) WITH CHECK (current_setting(''lori.personal_scope'',true)=''internal'' OR organization_id=nullif(current_setting(''lori.organization_id'',true),''''))',t);
 END LOOP;
END $$;
