-- Generated images and videos are stored in the conversation. A clip is paid for
-- before it arrives, so it may exceed the 20 MiB upload limit, and a flag rather
-- than a member-supplied media type decides which allowance a file counts against.
ALTER TABLE cloud_work_files ADD COLUMN generated BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE cloud_work_files
  DROP CONSTRAINT cloud_work_files_size_bytes_check,
  ADD CONSTRAINT cloud_work_files_size_bytes_check CHECK (size_bytes BETWEEN 0 AND 268435456);

ALTER TABLE cloud_work_file_versions
  DROP CONSTRAINT cloud_work_file_versions_size_bytes_check,
  ADD CONSTRAINT cloud_work_file_versions_size_bytes_check CHECK (size_bytes BETWEEN 0 AND 268435456);
