-- Expand-only. Enable sending explicitly after the maintenance cutover checks.
ALTER TABLE campaigns ADD COLUMN instance_id TEXT NOT NULL DEFAULT '';
ALTER TABLE campaigns ADD COLUMN active_since INTEGER NOT NULL DEFAULT 0;
ALTER TABLE campaigns ADD COLUMN resumed_at INTEGER;
UPDATE campaigns SET instance_id = lower(hex(randomblob(16))), active_since = CAST(strftime('%s','now') AS INTEGER);
CREATE TABLE legacy_campaign_instances (campaign_id TEXT PRIMARY KEY, instance_id TEXT NOT NULL);
INSERT INTO legacy_campaign_instances SELECT campaign_id,instance_id FROM campaigns;
CREATE UNIQUE INDEX campaign_instances ON campaigns(instance_id);
CREATE TABLE campaign_conflicts (campaign_id TEXT PRIMARY KEY, media_id TEXT NOT NULL);
INSERT INTO campaign_conflicts SELECT campaign_id, media_id FROM campaigns WHERE active = 1 AND archived_at IS NULL
  AND media_id IN (SELECT media_id FROM campaigns WHERE active = 1 AND archived_at IS NULL GROUP BY media_id HAVING COUNT(*) > 1);
UPDATE campaigns SET active = 0 WHERE campaign_id IN (SELECT campaign_id FROM campaign_conflicts);
CREATE UNIQUE INDEX one_active_campaign_per_media ON campaigns(media_id) WHERE active = 1 AND archived_at IS NULL;
ALTER TABLE conversations ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN pending_job_id TEXT;
ALTER TABLE conversations ADD COLUMN last_job_id TEXT;
ALTER TABLE conversations ADD COLUMN campaign_instance TEXT NOT NULL DEFAULT '';
UPDATE conversations SET campaign_instance = COALESCE((SELECT instance_id FROM campaigns WHERE campaigns.campaign_id = conversations.campaign_id), 'legacy');
CREATE TRIGGER conversation_instance_on_insert AFTER INSERT ON conversations WHEN NEW.campaign_instance=''
BEGIN
  UPDATE conversations SET campaign_instance=COALESCE((SELECT instance_id FROM campaigns WHERE campaign_id=NEW.campaign_id),'legacy')
    WHERE igsid=NEW.igsid AND campaign_id=NEW.campaign_id;
END;
CREATE TABLE automation_control (
  id INTEGER PRIMARY KEY CHECK(id = 1), enabled INTEGER NOT NULL DEFAULT 0,
  hold_reason TEXT, account_limit INTEGER NOT NULL DEFAULT 180, recipient_limit INTEGER NOT NULL DEFAULT 8,
  account_interval_ms INTEGER NOT NULL DEFAULT 1200, recipient_interval_ms INTEGER NOT NULL DEFAULT 2000,
  cutover_at INTEGER NOT NULL, build_revision TEXT NOT NULL DEFAULT 'reliability-v1'
);
INSERT INTO automation_control(id,cutover_at) VALUES(1,CAST(strftime('%s','now') AS INTEGER));
CREATE TABLE inbound_events (
  id TEXT PRIMARY KEY, generation INTEGER NOT NULL, recipient TEXT NOT NULL, source TEXT NOT NULL,
  event_ms INTEGER NOT NULL, content_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  next_at INTEGER NOT NULL DEFAULT 0, lease_token TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
  error TEXT, created_at INTEGER NOT NULL, touched_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX inbox_ready ON inbound_events(status,next_at,touched_at);
CREATE INDEX inbox_recipient_progress ON inbound_events(generation,recipient,touched_at);
CREATE TABLE outbound_jobs (
  id TEXT PRIMARY KEY, generation INTEGER NOT NULL, campaign_id TEXT NOT NULL, campaign_instance TEXT NOT NULL,
  recipient TEXT NOT NULL, action TEXT NOT NULL, event_id TEXT NOT NULL,
  expected_version INTEGER, request_json TEXT NOT NULL, transition_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0,
  owner_token TEXT, dispatch_at INTEGER, provider_id TEXT, error TEXT, error_code INTEGER, trace_id TEXT,
  finalized INTEGER NOT NULL DEFAULT 0, resolution_source TEXT, resolved_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(campaign_instance,recipient,action)
);
CREATE INDEX outbox_ready ON outbound_jobs(status,next_at,updated_at);
CREATE INDEX outbox_thread ON outbound_jobs(generation,recipient,status);
CREATE TABLE send_attempts (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL, generation INTEGER NOT NULL, recipient TEXT NOT NULL,
  is_dm INTEGER NOT NULL, dispatched_at INTEGER NOT NULL
);
CREATE INDEX attempts_account ON send_attempts(dispatched_at);
CREATE INDEX attempts_recipient ON send_attempts(recipient,dispatched_at);
CREATE TABLE polling_checkpoints (
  key TEXT PRIMARY KEY, generation INTEGER NOT NULL, cursor TEXT, boundary INTEGER NOT NULL,
  next_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
);
CREATE TABLE automation_audit (
  id TEXT PRIMARY KEY, job_id TEXT, action TEXT NOT NULL, created_at INTEGER NOT NULL
);
