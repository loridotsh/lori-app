ALTER TABLE member_usage_analytics_state
  ADD COLUMN revision BIGINT NOT NULL DEFAULT 1,
  ADD CONSTRAINT member_usage_state_revision_check CHECK (revision > 0);
