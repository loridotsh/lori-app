CREATE TABLE organization_policies (
  organization_id TEXT PRIMARY KEY REFERENCES organization(id),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  allow_personal_plugins BOOLEAN NOT NULL DEFAULT FALSE,
  allow_personal_skills BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by_user_id TEXT REFERENCES "user"(id)
);

INSERT INTO organization_policies (organization_id)
SELECT id FROM organization
ON CONFLICT (organization_id) DO NOTHING;

CREATE TABLE devices (
  id UUID PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organization(id),
  user_id TEXT NOT NULL REFERENCES "user"(id),
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  platform TEXT NOT NULL CHECK (platform IN ('macos', 'windows', 'linux')),
  app_version TEXT NOT NULL CHECK (char_length(app_version) BETWEEN 1 AND 40),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoked_by_user_id TEXT REFERENCES "user"(id),
  revoked_reason TEXT
);
CREATE INDEX devices_organization_id_idx ON devices (organization_id);
CREATE INDEX devices_user_id_idx ON devices (user_id);
CREATE INDEX devices_active_idx
  ON devices (organization_id, user_id)
  WHERE revoked_at IS NULL;

CREATE TABLE enrollment_codes (
  id UUID PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  organization_id TEXT NOT NULL REFERENCES organization(id),
  user_id TEXT NOT NULL REFERENCES "user"(id),
  device_id UUID NOT NULL,
  device_name TEXT NOT NULL CHECK (char_length(device_name) BETWEEN 1 AND 80),
  platform TEXT NOT NULL CHECK (platform IN ('macos', 'windows', 'linux')),
  app_version TEXT NOT NULL CHECK (char_length(app_version) BETWEEN 1 AND 40),
  code_challenge TEXT NOT NULL CHECK (char_length(code_challenge) = 43),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);
CREATE INDEX enrollment_codes_expires_at_idx ON enrollment_codes (expires_at);
CREATE INDEX enrollment_codes_user_id_idx ON enrollment_codes (user_id);

CREATE TABLE device_sessions (
  id UUID PRIMARY KEY,
  device_id UUID NOT NULL REFERENCES devices(id),
  token_family_id UUID NOT NULL,
  access_token_hash TEXT NOT NULL UNIQUE,
  access_expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoked_reason TEXT
);
CREATE INDEX device_sessions_device_id_idx ON device_sessions (device_id);
CREATE INDEX device_sessions_token_family_id_idx
  ON device_sessions (token_family_id);
CREATE INDEX device_sessions_active_access_idx
  ON device_sessions (access_token_hash)
  WHERE revoked_at IS NULL;

CREATE TABLE device_refresh_tokens (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES device_sessions(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);
CREATE INDEX device_refresh_tokens_session_id_idx
  ON device_refresh_tokens (session_id);
CREATE INDEX device_refresh_tokens_expires_at_idx
  ON device_refresh_tokens (expires_at);
