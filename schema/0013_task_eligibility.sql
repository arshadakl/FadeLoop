-- Additive: suspension is orthogonal to lease/fault status. Old code can still
-- read the table, but only an eligibility-aware scheduler may own task execution.
ALTER TABLE work_tasks ADD COLUMN suspend_reason TEXT;
CREATE INDEX tasks_eligible ON work_tasks(generation,status,suspend_reason,next_at_ms);
