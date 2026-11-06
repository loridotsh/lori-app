CREATE TABLE cloud_work_plugin_connections (
 id UUID PRIMARY KEY, organization_id TEXT NOT NULL, member_id TEXT NOT NULL, plugin_id TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0), enabled BOOLEAN NOT NULL DEFAULT FALSE,
 status TEXT NOT NULL DEFAULT 'disconnected' CHECK(status IN ('connecting','connected','disconnected','reauthRequired')),
 credential TEXT, oauth_client TEXT, tools JSONB NOT NULL DEFAULT '[]', resources JSONB NOT NULL DEFAULT '[]',
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(organization_id,member_id,plugin_id),
 FOREIGN KEY(member_id,organization_id) REFERENCES member(id,"organizationId") ON DELETE CASCADE
);
CREATE TABLE cloud_work_extension_preferences (
 organization_id TEXT NOT NULL, member_id TEXT NOT NULL, skill_id TEXT NOT NULL, enabled BOOLEAN NOT NULL,
 PRIMARY KEY(organization_id,member_id,skill_id),
 FOREIGN KEY(member_id,organization_id) REFERENCES member(id,"organizationId") ON DELETE CASCADE
);
CREATE TABLE cloud_work_plugin_authorizations (
 state_hash TEXT PRIMARY KEY, connection_id UUID NOT NULL REFERENCES cloud_work_plugin_connections(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL, session_hash TEXT NOT NULL, sealed TEXT NOT NULL,
 expires_at TIMESTAMPTZ NOT NULL, claimed_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX cloud_work_plugin_authorizations_expiry ON cloud_work_plugin_authorizations(expires_at);
