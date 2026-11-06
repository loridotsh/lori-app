CREATE TABLE cloud_work_memory_settings (
 organization_id TEXT NOT NULL,member_id TEXT NOT NULL,enabled BOOLEAN NOT NULL DEFAULT TRUE,revision INTEGER NOT NULL DEFAULT 1,
 PRIMARY KEY(organization_id,member_id),FOREIGN KEY(member_id,organization_id) REFERENCES member(id,"organizationId") ON DELETE CASCADE
);
CREATE TABLE cloud_work_memory_notes (
 id UUID PRIMARY KEY,organization_id TEXT NOT NULL,member_id TEXT NOT NULL,
 scope TEXT NOT NULL CHECK(scope IN ('personal','conversation')),
 conversation_id UUID REFERENCES cloud_work_conversations(id) ON DELETE CASCADE,
 topic TEXT NOT NULL CHECK(length(topic) BETWEEN 1 AND 160),content TEXT NOT NULL CHECK(octet_length(content) BETWEEN 1 AND 12000),
 sensitive BOOLEAN NOT NULL DEFAULT FALSE,revision INTEGER NOT NULL DEFAULT 1,
 provenance TEXT NOT NULL CHECK(provenance IN ('manual','approved_tool')),
 source_message_id UUID REFERENCES cloud_work_messages(id) ON DELETE SET NULL,
 source_evidence TEXT,approval_id UUID REFERENCES cloud_work_approvals(id) ON DELETE SET NULL,
 search_vector TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple',topic||' '||content)) STORED,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 FOREIGN KEY(member_id,organization_id) REFERENCES member(id,"organizationId") ON DELETE CASCADE,
 CHECK((scope='personal' AND conversation_id IS NULL) OR (scope='conversation' AND conversation_id IS NOT NULL))
);
CREATE INDEX cloud_work_memory_scope ON cloud_work_memory_notes(organization_id,member_id,scope,conversation_id);
CREATE INDEX cloud_work_memory_search ON cloud_work_memory_notes USING GIN(search_vector);
ALTER TABLE cloud_work_memory_notes ADD CONSTRAINT cloud_memory_conversation_owner FOREIGN KEY(conversation_id,organization_id,member_id) REFERENCES cloud_work_conversations(id,organization_id,member_id) ON DELETE CASCADE;
