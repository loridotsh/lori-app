DELETE FROM audit_events
WHERE action LIKE 'enterprise_link.%'
   OR subject_type = 'enterprise_link';

DROP TABLE IF EXISTS enterprise_link;
