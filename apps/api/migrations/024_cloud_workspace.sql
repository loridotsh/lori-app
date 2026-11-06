ALTER TABLE cloud_work_runs DROP CONSTRAINT cloud_work_runs_status_check;
ALTER TABLE cloud_work_runs ADD CONSTRAINT cloud_work_runs_status_check CHECK(status IN ('queued','running','awaitingApproval','completed','cancelled','failed','interrupted'));
DROP INDEX cloud_work_one_active;
CREATE UNIQUE INDEX cloud_work_one_active ON cloud_work_runs(conversation_id) WHERE status IN ('queued','running','awaitingApproval');
ALTER TABLE cloud_work_messages ADD COLUMN attachment_ids JSONB NOT NULL DEFAULT '[]';
CREATE TABLE cloud_work_files (
 id UUID PRIMARY KEY, conversation_id UUID NOT NULL REFERENCES cloud_work_conversations(id) ON DELETE CASCADE,
 path TEXT NOT NULL CHECK(length(path) BETWEEN 1 AND 240), mime_type TEXT NOT NULL,
 size_bytes INTEGER NOT NULL CHECK(size_bytes BETWEEN 0 AND 20971520), sha256 TEXT NOT NULL,
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(conversation_id,path)
);
CREATE TABLE cloud_work_file_versions (
 file_id UUID NOT NULL REFERENCES cloud_work_files(id) ON DELETE CASCADE,
 version INTEGER NOT NULL, storage_key UUID NOT NULL UNIQUE, size_bytes INTEGER NOT NULL CHECK(size_bytes BETWEEN 0 AND 20971520),
 sha256 TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(file_id,version)
);
CREATE TABLE cloud_work_mutations (
 organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
 member_id TEXT NOT NULL, request_id UUID NOT NULL, fingerprint TEXT NOT NULL, response JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(organization_id,member_id,request_id),
 FOREIGN KEY(member_id,organization_id) REFERENCES member(id,"organizationId") ON DELETE CASCADE
);
CREATE TABLE cloud_work_rounds (
 id UUID PRIMARY KEY, run_id UUID NOT NULL REFERENCES cloud_work_runs(id) ON DELETE CASCADE,
 round_index INTEGER NOT NULL CHECK(round_index BETWEEN 0 AND 15), request_fingerprint TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'started' CHECK(status IN ('started','completed')),
 assistant JSONB, tool_calls JSONB NOT NULL DEFAULT '[]', receipt_fingerprint TEXT,
 usage JSONB, finish_reason TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), completed_at TIMESTAMPTZ,
 UNIQUE(run_id,round_index), UNIQUE(id,run_id)
);
CREATE TABLE cloud_work_tool_invocations (
 id UUID PRIMARY KEY, run_id UUID NOT NULL REFERENCES cloud_work_runs(id) ON DELETE CASCADE,
 round_id UUID NOT NULL, call_id TEXT NOT NULL, request_id UUID NOT NULL,
 name TEXT NOT NULL, arguments JSONB NOT NULL, action_hash TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pendingApproval','running','completed','failed','denied','unknown')),
 output JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(run_id,request_id), UNIQUE(round_id,call_id), UNIQUE(id,run_id),
 FOREIGN KEY(round_id,run_id) REFERENCES cloud_work_rounds(id,run_id) ON DELETE CASCADE
);
CREATE TABLE cloud_work_approvals (
 id UUID PRIMARY KEY,run_id UUID NOT NULL, invocation_id UUID NOT NULL UNIQUE,
 action_hash TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','denied','expired')),
 decision_request_id UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),decided_at TIMESTAMPTZ,
 FOREIGN KEY(invocation_id,run_id) REFERENCES cloud_work_tool_invocations(id,run_id) ON DELETE CASCADE
);
ALTER TABLE cloud_work_events DROP CONSTRAINT cloud_work_events_type_check;
ALTER TABLE cloud_work_events ADD CONSTRAINT cloud_work_events_type_check CHECK(type IN ('run.queued','run.started','assistant.delta','run.completed','run.cancelled','run.failed','run.interrupted','tool.requested','tool.completed','tool.failed','approval.requested','approval.decided','file.updated'));
ALTER TABLE cloud_work_tool_invocations ADD COLUMN model_output JSONB;
ALTER TABLE cloud_work_workers ADD COLUMN capabilities JSONB NOT NULL DEFAULT '{}';
ALTER TABLE cloud_work_tool_invocations DROP CONSTRAINT cloud_work_tool_invocations_status_check;
ALTER TABLE cloud_work_tool_invocations ADD CONSTRAINT cloud_work_tool_invocations_status_check CHECK(status IN ('pendingApproval','pendingExecution','running','completed','failed','denied','unknown'));
ALTER TABLE cloud_work_tool_invocations ADD COLUMN execution JSONB,ADD COLUMN execution_started BOOLEAN NOT NULL DEFAULT FALSE,ADD COLUMN execution_finished BOOLEAN NOT NULL DEFAULT FALSE,ADD COLUMN execution_failed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE cloud_work_approvals DROP CONSTRAINT cloud_work_approvals_invocation_id_key;
CREATE TABLE cloud_work_staged_files (
 invocation_id UUID NOT NULL REFERENCES cloud_work_tool_invocations(id) ON DELETE CASCADE,
 path TEXT NOT NULL, storage_key UUID NOT NULL UNIQUE, sha256 TEXT NOT NULL,size_bytes INTEGER NOT NULL,
 expected_file_id UUID, expected_version INTEGER,expected_hash TEXT,
 PRIMARY KEY(invocation_id,path)
);

ALTER TABLE cloud_work_runs ADD COLUMN worker_capabilities JSONB NOT NULL DEFAULT '{}';
ALTER TABLE cloud_work_tool_invocations ADD COLUMN execution_result_fingerprint TEXT;
ALTER TABLE cloud_work_approvals ADD COLUMN kind TEXT NOT NULL DEFAULT 'tool' CHECK(kind IN ('tool','apply_files')),ADD COLUMN summary TEXT,ADD COLUMN files JSONB;
