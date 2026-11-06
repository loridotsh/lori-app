-- Keep idempotency keys, but never retain deleted note content in receipts.
-- A trigger also covers conversation retention and foreign-key cascades.
CREATE FUNCTION redact_cloud_memory_receipts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE cloud_work_mutations
  SET response = jsonb_build_object('id', OLD.id, 'deleted', true)
  WHERE organization_id = OLD.organization_id AND member_id = OLD.member_id
    AND response->>'id' = OLD.id::text;
  RETURN OLD;
END;
$$;

CREATE TRIGGER cloud_memory_receipt_deletion
AFTER DELETE ON cloud_work_memory_notes
FOR EACH ROW EXECUTE FUNCTION redact_cloud_memory_receipts();

-- Repair receipts for notes deleted before this migration. Memory receipts
-- have scope/provenance fields; workspace-file receipts do not.
UPDATE cloud_work_mutations m
SET response = jsonb_build_object('id', m.response->>'id', 'deleted', true)
WHERE m.response->>'scope' IN ('personal', 'conversation')
  AND m.response->>'provenance' IN ('manual', 'approved_tool')
  AND NOT EXISTS (
    SELECT 1 FROM cloud_work_memory_notes n
    WHERE n.id::text = m.response->>'id'
      AND n.organization_id = m.organization_id AND n.member_id = m.member_id
  );
