-- Additive repairs. Keep sending disabled until the held-build checks pass.
UPDATE automation_control SET enabled=0,build_revision='reliability-v2';
ALTER TABLE polling_checkpoints ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE polling_checkpoints ADD COLUMN last_attempt_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE polling_checkpoints ADD COLUMN last_error TEXT;
UPDATE polling_checkpoints SET last_attempt_at=updated_at;
CREATE INDEX checkpoint_due ON polling_checkpoints(generation,next_at,last_attempt_at);
ALTER TABLE conversations ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'active';
ALTER TABLE conversations ADD COLUMN event_boundary_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN terminal_job_id TEXT;
ALTER TABLE conversations ADD COLUMN terminal_reason TEXT;
UPDATE conversations SET lifecycle=CASE WHEN state='DONE' THEN 'completed' ELSE 'active' END,
  event_boundary_ms=COALESCE((SELECT e.event_ms FROM outbound_jobs j JOIN inbound_events e ON e.id=j.event_id
    WHERE j.campaign_instance=conversations.campaign_instance AND j.recipient=conversations.igsid AND j.action='opening'),created_at*1000);
UPDATE conversations SET lifecycle=CASE WHEN (SELECT status FROM outbound_jobs WHERE id=pending_job_id)='rejected' THEN 'failed' ELSE 'closed' END,
  terminal_job_id=pending_job_id,terminal_reason=CASE WHEN (SELECT status FROM outbound_jobs WHERE id=pending_job_id)='rejected' THEN 'provider_rejected' ELSE 'owner_closed_unresolved' END,
  pending_job_id=NULL,version=version+1
  WHERE EXISTS(SELECT 1 FROM outbound_jobs j WHERE j.id=conversations.pending_job_id
    AND j.campaign_instance=conversations.campaign_instance AND j.recipient=conversations.igsid AND j.expected_version=conversations.version
    AND (j.status='rejected' OR (j.status='cancelled' AND j.resolution_source='owner_closed_unresolved')));
INSERT OR IGNORE INTO automation_audit(id,job_id,action,created_at)
  SELECT 'repair_terminal:'||terminal_job_id,terminal_job_id,'migration_terminal_repair',CAST(strftime('%s','now') AS INTEGER)*1000
  FROM conversations WHERE terminal_job_id IS NOT NULL;
-- A previous pause may have erased Retry-After. Never guess that dispatched work is due.
UPDATE outbound_jobs SET error=CASE WHEN attempts=0 THEN NULL ELSE 'Legacy retry deadline requires owner review' END,
  status=CASE WHEN attempts=0 THEN 'pending' ELSE 'held' END,
  next_at=CASE WHEN attempts=0 THEN next_at ELSE 9007199254740991 END
  WHERE status='held' AND error='Campaign paused or archived';
