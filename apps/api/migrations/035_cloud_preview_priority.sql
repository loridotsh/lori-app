-- Pages rendered ahead of time (when a document is saved, and reading ahead) must never delay a page a
-- member is waiting for. Priority 0 is a member waiting; 1 is background preparation.
ALTER TABLE cloud_work_file_previews ADD COLUMN priority SMALLINT NOT NULL DEFAULT 0 CHECK (priority IN (0, 1));
DROP INDEX IF EXISTS cloud_work_previews_queue;
CREATE INDEX cloud_work_previews_queue ON cloud_work_file_previews(priority, created_at) WHERE status='queued';
