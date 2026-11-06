-- Derived, rebuildable semantic indexes. Canonical memory is unchanged; dropping
-- these rows or columns only falls retrieval back to lexical search.
CREATE TABLE cloud_work_memory_vectors (
 note_id UUID NOT NULL REFERENCES cloud_work_memory_notes(id) ON DELETE CASCADE,
 chunk SMALLINT NOT NULL CHECK(chunk >= 0),
 revision INTEGER NOT NULL,
 model TEXT NOT NULL,
 span_start INTEGER NOT NULL,
 span_end INTEGER NOT NULL,
 scale REAL NOT NULL,
 vector BYTEA NOT NULL CHECK(octet_length(vector) = 384),
 PRIMARY KEY(note_id, chunk)
);

-- An edit, or a note becoming sensitive, withdraws its vectors in the same transaction.
CREATE FUNCTION lori_cloud_memory_vectors_invalidate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM cloud_work_memory_vectors WHERE note_id = NEW.id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cloud_memory_vectors_invalidate
AFTER UPDATE OF topic, content, sensitive ON cloud_work_memory_notes
FOR EACH ROW
WHEN (OLD.topic IS DISTINCT FROM NEW.topic OR OLD.content IS DISTINCT FROM NEW.content OR OLD.sensitive IS DISTINCT FROM NEW.sensitive)
EXECUTE FUNCTION lori_cloud_memory_vectors_invalidate();

-- Team-project vectors live inside the project's encryption envelope, never as plaintext columns.
ALTER TABLE cloud_work_project_search
 ADD COLUMN vectors JSONB CHECK(vectors IS NULL OR (vectors->>'$project'='1') IS TRUE),
 ADD COLUMN semantic_revision BIGINT NOT NULL DEFAULT -1;
