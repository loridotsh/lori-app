-- Conversation IDs are random UUIDs. Recency and pagination follow activity.
CREATE INDEX cloud_work_conversations_owner_recency
  ON cloud_work_conversations(organization_id,member_id,updated_at DESC,id DESC);
