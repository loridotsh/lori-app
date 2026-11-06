-- Planning content remains in the existing encrypted, scoped tool receipts.
-- A monotonic revision orders snapshots without relying on wall clocks.
ALTER TABLE cloud_work_tool_invocations ADD COLUMN todo_revision BIGINT
  CHECK (todo_revision IS NULL OR (name='write_todos' AND todo_revision BETWEEN 1 AND 9007199254740991));
CREATE INDEX cloud_work_todo_latest ON cloud_work_tool_invocations(run_id,todo_revision DESC)
  WHERE name='write_todos' AND status='completed';
