CREATE TABLE enterprise_link (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  deployment_id UUID NOT NULL,
  lori_account_origin TEXT NOT NULL,
  paired_by_user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  paired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
