-- A personal workspace is a one-person organization, so every tenant-scoped
-- table, policy and RLS rule applies to individuals unchanged. A person holds
-- at most one, and it outlives any enterprise they join or leave.
ALTER TABLE organization
  ADD COLUMN personal_user_id TEXT UNIQUE REFERENCES "user"(id);
