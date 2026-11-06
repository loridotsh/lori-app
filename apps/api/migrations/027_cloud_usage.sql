-- Cloud counters use their own server-owned sources; no device is impersonated.
ALTER TABLE usage_analytics_sources
 ADD COLUMN delivery_location TEXT NOT NULL DEFAULT 'desktop' CHECK(delivery_location IN ('desktop','cloud')),
 ADD CONSTRAINT cloud_usage_source_identity CHECK(delivery_location<>'cloud' OR (product='work' AND work_device_id IS NULL AND last_device_id IS NULL));
ALTER TABLE cloud_work_runs ADD COLUMN usage_admission JSONB;
ALTER TABLE cloud_work_rounds ADD COLUMN usage_sequence BIGINT NOT NULL DEFAULT 0,ADD COLUMN usage_fingerprint TEXT;
-- Independent of private chat retention: existing Enterprise source deletion/anonymization applies.
CREATE TABLE cloud_usage_rounds (
 source_id UUID NOT NULL,organization_id TEXT NOT NULL,round_id UUID NOT NULL UNIQUE,run_id UUID NOT NULL,
 usage_date DATE NOT NULL,agent_id TEXT NOT NULL CHECK(agent_id IN ('work-agent','work-text','work-title','work-memory','work-summary')),
 model TEXT NOT NULL CHECK(char_length(model)<=128),provider_id TEXT NOT NULL,
 sequence BIGINT NOT NULL DEFAULT 0,usage JSONB NOT NULL,
 input_tokens BIGINT CHECK(input_tokens>=0),output_tokens BIGINT CHECK(output_tokens>=0),
 cache_read_tokens BIGINT CHECK(cache_read_tokens>=0),cache_write_tokens BIGINT CHECK(cache_write_tokens>=0),reasoning_tokens BIGINT CHECK(reasoning_tokens>=0),
 first_received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),last_received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(source_id,round_id),
 FOREIGN KEY(source_id,organization_id) REFERENCES usage_analytics_sources(id,organization_id) ON DELETE CASCADE
);
CREATE INDEX cloud_usage_rounds_date ON cloud_usage_rounds(organization_id,usage_date);
