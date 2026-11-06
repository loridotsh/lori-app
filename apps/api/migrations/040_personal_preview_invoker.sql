-- Apply the runtime caller's RLS scope even when a superuser owns these views.
-- Keep this as a forward migration for installations that already applied 039.
ALTER VIEW cloud_work_preview_sources SET (security_invoker = true);
ALTER VIEW cloud_work_preview_source_versions SET (security_invoker = true);
