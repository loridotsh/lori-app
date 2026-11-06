-- Private, bounded, disposable render cache. Previewing never creates workspace files.
CREATE TABLE cloud_work_file_previews (
  id UUID PRIMARY KEY,
  file_id UUID NOT NULL REFERENCES cloud_work_files(id) ON DELETE CASCADE,
  file_version INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  page INTEGER NOT NULL CHECK (page BETWEEN 1 AND 10000),
  status TEXT NOT NULL CHECK (status IN ('queued','running','ready','failed')),
  lease UUID,
  lease_until TIMESTAMPTZ,
  total_pages INTEGER,
  image BYTEA CHECK (octet_length(image) <= 4194304),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(file_id,sha256,page)
);
CREATE INDEX cloud_work_previews_queue ON cloud_work_file_previews(created_at) WHERE status='queued';
