ALTER TABLE organization_policies
  ADD COLUMN allow_personal_providers BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE organization_catalog_policies (
  organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL CHECK (item_type IN ('app', 'plugin', 'provider', 'skill')),
  item_id TEXT NOT NULL,
  enabled BOOLEAN NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by_user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  PRIMARY KEY (organization_id, item_type, item_id)
);

CREATE TABLE member_policy_overrides (
  member_id TEXT PRIMARY KEY REFERENCES member(id) ON DELETE CASCADE,
  allow_personal_plugins BOOLEAN,
  allow_personal_providers BOOLEAN,
  allow_personal_skills BOOLEAN,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by_user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL
);

CREATE TABLE member_catalog_overrides (
  member_id TEXT NOT NULL REFERENCES member(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL CHECK (item_type IN ('app', 'plugin', 'provider', 'skill')),
  item_id TEXT NOT NULL,
  enabled BOOLEAN NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by_user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  PRIMARY KEY (member_id, item_type, item_id)
);

CREATE INDEX idx_member_catalog_overrides_member
  ON member_catalog_overrides(member_id);
