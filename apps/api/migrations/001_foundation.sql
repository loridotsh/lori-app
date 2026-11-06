CREATE TABLE deployment_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO deployment_metadata (key, value)
VALUES ('storage_model', 'postgresql');
