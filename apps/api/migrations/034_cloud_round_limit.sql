-- A response may now take up to 32 provider rounds (the last one a tool-free
-- wrap-up) instead of failing at 16. Matches MAX_ROUNDS in run-budget.ts and
-- the shared agent core's limit.
ALTER TABLE cloud_work_rounds DROP CONSTRAINT cloud_work_rounds_round_index_check;
ALTER TABLE cloud_work_rounds ADD CONSTRAINT cloud_work_rounds_round_index_check CHECK (round_index BETWEEN 0 AND 31);
