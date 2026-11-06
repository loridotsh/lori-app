CREATE TABLE cloud_work_member_preferences (
  organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL,
  approval_mode TEXT NOT NULL DEFAULT 'askMe' CHECK (approval_mode IN ('askMe','approveForMe')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (organization_id, member_id),
  FOREIGN KEY (member_id, organization_id) REFERENCES member(id,"organizationId") ON DELETE CASCADE
);
ALTER TABLE cloud_work_approvals
  ADD COLUMN decision_source TEXT NOT NULL DEFAULT 'user' CHECK (decision_source IN ('user','automatic')),
  ADD COLUMN preference_revision INTEGER;
