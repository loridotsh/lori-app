-- Cloud Work availability is governed solely by the organization's Work policy
-- (Manage Work Access). The legacy per-organization switch is retained only for
-- schema compatibility and is always on, so enabling Work reaches Cloud Work.
ALTER TABLE cloud_work_settings ALTER COLUMN enabled SET DEFAULT TRUE;
UPDATE cloud_work_settings SET enabled=TRUE WHERE enabled IS NOT TRUE;
