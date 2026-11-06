-- Cloud Work deliberately does not alter the existing Work policy v1.
CREATE TABLE cloud_work_settings (
 organization_id TEXT PRIMARY KEY REFERENCES organization(id) ON DELETE CASCADE,
 enabled BOOLEAN NOT NULL DEFAULT FALSE,
 retention_days INTEGER NOT NULL DEFAULT 90 CHECK(retention_days BETWEEN 1 AND 365),
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0)
);
CREATE UNIQUE INDEX cloud_work_member_tenant ON member(id,"organizationId");
CREATE TABLE cloud_work_conversations (
 id UUID PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
 member_id TEXT NOT NULL,
 title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200), revision INTEGER NOT NULL DEFAULT 1,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(id,organization_id,member_id),
 FOREIGN KEY(member_id,organization_id) REFERENCES member(id,"organizationId") ON DELETE CASCADE
);
CREATE INDEX cloud_work_conversations_owner ON cloud_work_conversations(organization_id,member_id,id);
CREATE TABLE cloud_work_runs (
 id UUID PRIMARY KEY, conversation_id UUID NOT NULL,
 organization_id TEXT NOT NULL, member_id TEXT NOT NULL,
 request_id UUID NOT NULL, fingerprint TEXT NOT NULL,
 gateway_id TEXT NOT NULL, model_id TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','cancelled','failed','interrupted')),
 lease_id UUID, lease_version INTEGER NOT NULL DEFAULT 0, lease_until TIMESTAMPTZ,
 worker_id TEXT, admitted_device_id UUID, admitted_device_session_id UUID, admitted_browser_session_id TEXT, provider_started BOOLEAN NOT NULL DEFAULT FALSE,
 error_code TEXT, last_sequence INTEGER NOT NULL DEFAULT 0,
 assistant_text TEXT NOT NULL DEFAULT '' CHECK(octet_length(assistant_text)<=1048576),
 usage JSONB, finish_reason TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 FOREIGN KEY(conversation_id,organization_id,member_id) REFERENCES cloud_work_conversations(id,organization_id,member_id) ON DELETE CASCADE,
 UNIQUE(organization_id,member_id,request_id),
 UNIQUE(id,conversation_id)
);
CREATE UNIQUE INDEX cloud_work_one_active ON cloud_work_runs(conversation_id) WHERE status IN ('queued','running');
CREATE INDEX cloud_work_claims ON cloud_work_runs(created_at) WHERE status='queued';
CREATE TABLE cloud_work_messages (
 id UUID PRIMARY KEY, conversation_id UUID NOT NULL REFERENCES cloud_work_conversations(id) ON DELETE CASCADE,
 run_id UUID NOT NULL REFERENCES cloud_work_runs(id) ON DELETE CASCADE,
 role TEXT NOT NULL CHECK(role IN ('user','assistant')), text TEXT NOT NULL CHECK(octet_length(text)<=1048576),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(run_id,role),
 FOREIGN KEY(run_id,conversation_id) REFERENCES cloud_work_runs(id,conversation_id) ON DELETE CASCADE
);
CREATE INDEX cloud_work_messages_conversation ON cloud_work_messages(conversation_id,created_at,id);
CREATE TABLE cloud_work_events (
 run_id UUID NOT NULL REFERENCES cloud_work_runs(id) ON DELETE CASCADE,
 sequence INTEGER NOT NULL, request_id UUID, fingerprint TEXT,
 type TEXT NOT NULL CHECK(type IN ('run.queued','run.started','assistant.delta','run.completed','run.cancelled','run.failed','run.interrupted')),
 data JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(run_id,sequence), UNIQUE(run_id,request_id)
);

CREATE TABLE cloud_work_workers (id TEXT PRIMARY KEY, last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
