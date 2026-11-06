-- Where in the assistant's reply each tool call happened, so the transcript can
-- show text and tool activity in the order they occurred. NULL for older runs.
ALTER TABLE cloud_work_tool_invocations ADD COLUMN text_offset INTEGER CHECK(text_offset IS NULL OR text_offset>=0);
