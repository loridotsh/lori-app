CREATE TABLE "user" (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  "emailVerified" BOOLEAN NOT NULL DEFAULT FALSE,
  image TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL,
  "updatedAt" TIMESTAMPTZ NOT NULL
);

CREATE TABLE session (
  id TEXT PRIMARY KEY,
  "expiresAt" TIMESTAMPTZ NOT NULL,
  token TEXT NOT NULL UNIQUE,
  "createdAt" TIMESTAMPTZ NOT NULL,
  "updatedAt" TIMESTAMPTZ NOT NULL,
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "userId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "activeOrganizationId" TEXT
);
CREATE INDEX session_user_id_idx ON session ("userId");

CREATE TABLE account (
  id TEXT PRIMARY KEY,
  "accountId" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "userId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "accessToken" TEXT,
  "refreshToken" TEXT,
  "idToken" TEXT,
  "accessTokenExpiresAt" TIMESTAMPTZ,
  "refreshTokenExpiresAt" TIMESTAMPTZ,
  scope TEXT,
  password TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL,
  "updatedAt" TIMESTAMPTZ NOT NULL
);
CREATE INDEX account_user_id_idx ON account ("userId");

CREATE TABLE verification (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  "expiresAt" TIMESTAMPTZ NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL,
  "updatedAt" TIMESTAMPTZ NOT NULL
);
CREATE INDEX verification_identifier_idx ON verification (identifier);

CREATE TABLE organization (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  logo TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL,
  metadata TEXT
);
CREATE INDEX organization_slug_idx ON organization (slug);

ALTER TABLE session
  ADD CONSTRAINT session_active_organization_fk
  FOREIGN KEY ("activeOrganizationId") REFERENCES organization(id)
  ON DELETE SET NULL;

CREATE TABLE member (
  id TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL REFERENCES organization(id),
  "userId" TEXT NOT NULL REFERENCES "user"(id),
  role TEXT NOT NULL DEFAULT 'member',
  "createdAt" TIMESTAMPTZ NOT NULL,
  CONSTRAINT member_role_check CHECK (role IN ('admin', 'member')),
  CONSTRAINT member_organization_user_unique UNIQUE ("organizationId", "userId")
);
CREATE INDEX member_organization_id_idx ON member ("organizationId");
CREATE INDEX member_user_id_idx ON member ("userId");

CREATE TABLE invitation (
  id TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL REFERENCES organization(id),
  email TEXT NOT NULL,
  role TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  "expiresAt" TIMESTAMPTZ NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL,
  "inviterId" TEXT NOT NULL REFERENCES "user"(id),
  CONSTRAINT invitation_role_check CHECK (role IN ('admin', 'member')),
  CONSTRAINT invitation_status_check
    CHECK (status IN ('pending', 'accepted', 'rejected', 'canceled'))
);
CREATE INDEX invitation_organization_id_idx ON invitation ("organizationId");
CREATE INDEX invitation_email_idx ON invitation (email);

CREATE TABLE "rateLimit" (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  count INTEGER NOT NULL,
  "lastRequest" BIGINT NOT NULL
);

CREATE TABLE deployment_setup (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  completed_at TIMESTAMPTZ,
  organization_id TEXT REFERENCES organization(id),
  admin_user_id TEXT REFERENCES "user"(id),
  CHECK (
    (completed_at IS NULL AND organization_id IS NULL AND admin_user_id IS NULL)
    OR
    (completed_at IS NOT NULL AND organization_id IS NOT NULL AND admin_user_id IS NOT NULL)
  )
);
INSERT INTO deployment_setup (singleton) VALUES (TRUE);

CREATE TABLE invite_links (
  id UUID PRIMARY KEY,
  invitation_id TEXT NOT NULL REFERENCES invitation(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  consumed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX invite_links_invitation_id_idx ON invite_links (invitation_id);

CREATE TABLE audit_events (
  id UUID PRIMARY KEY,
  action TEXT NOT NULL,
  actor_user_id TEXT,
  subject_type TEXT,
  subject_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX audit_events_created_at_idx ON audit_events (created_at DESC);
CREATE INDEX audit_events_actor_user_id_idx ON audit_events (actor_user_id);
