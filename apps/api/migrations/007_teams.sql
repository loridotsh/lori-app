-- Teams provide an additive policy scope between the organization and a
-- member. Team catalog rows are positive assignments; per-team member rows
-- remain tri-state and may explicitly add or remove that team's contribution.
CREATE TABLE team (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  slug TEXT NOT NULL CHECK (
    char_length(slug) BETWEEN 2 AND 49
    AND slug ~ '^[a-z0-9][a-z0-9-]{1,48}$'
  ),
  description TEXT CHECK (
    description IS NULL OR char_length(description) <= 500
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by_user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  UNIQUE (organization_id, slug)
);
CREATE INDEX team_organization_id_idx ON team (organization_id);

CREATE TABLE team_member (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES team(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES member(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member'
    CHECK (role IN ('team_admin', 'member')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (team_id, member_id)
);
CREATE INDEX team_member_team_id_idx ON team_member (team_id);
CREATE INDEX team_member_member_id_idx ON team_member (member_id);
CREATE INDEX team_member_admin_idx
  ON team_member (member_id, team_id)
  WHERE role = 'team_admin';

CREATE TABLE team_policies (
  team_id TEXT PRIMARY KEY REFERENCES team(id) ON DELETE CASCADE,
  allow_personal_plugins BOOLEAN NOT NULL DEFAULT FALSE,
  allow_personal_providers BOOLEAN NOT NULL DEFAULT FALSE,
  allow_personal_skills BOOLEAN NOT NULL DEFAULT FALSE,
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by_user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL
);

CREATE TABLE team_catalog_policies (
  team_id TEXT NOT NULL REFERENCES team(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL
    CHECK (item_type IN ('app', 'plugin', 'provider', 'skill')),
  item_id TEXT NOT NULL,
  enabled BOOLEAN NOT NULL CHECK (enabled),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by_user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  PRIMARY KEY (team_id, item_type, item_id)
);

CREATE TABLE team_member_policy_overrides (
  team_member_id TEXT PRIMARY KEY
    REFERENCES team_member(id) ON DELETE CASCADE,
  allow_personal_plugins BOOLEAN,
  allow_personal_providers BOOLEAN,
  allow_personal_skills BOOLEAN,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by_user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL
);

CREATE TABLE team_member_catalog_overrides (
  team_member_id TEXT NOT NULL
    REFERENCES team_member(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL
    CHECK (item_type IN ('app', 'plugin', 'provider', 'skill')),
  item_id TEXT NOT NULL,
  enabled BOOLEAN NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by_user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  PRIMARY KEY (team_member_id, item_type, item_id)
);
CREATE INDEX team_member_catalog_overrides_team_member_idx
  ON team_member_catalog_overrides (team_member_id);
