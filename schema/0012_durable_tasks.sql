-- Expand-only. Existing campaign, conversation and outbound identities are unchanged.
CREATE TABLE work_tasks (
  id TEXT PRIMARY KEY, generation INTEGER NOT NULL, kind TEXT NOT NULL,
  reference TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','leased','done','blocked')),
  next_at_ms INTEGER NOT NULL DEFAULT 0, lease_token TEXT, lease_until_ms INTEGER NOT NULL DEFAULT 0,
  notification_token TEXT, notification_until_ms INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0, error TEXT, updated_at_ms INTEGER NOT NULL
);
CREATE INDEX tasks_ready ON work_tasks(generation,status,next_at_ms,notification_until_ms);
CREATE INDEX tasks_leases ON work_tasks(generation,status,lease_until_ms);
CREATE INDEX tasks_retention ON work_tasks(status,updated_at_ms);
CREATE INDEX tasks_status_page ON work_tasks(generation,status,id);
CREATE TABLE ingress_batches (
  id TEXT PRIMARY KEY, generation INTEGER NOT NULL, source TEXT NOT NULL,
  raw_json TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending', created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
);
CREATE INDEX ingress_retention ON ingress_batches(status,updated_at_ms);
CREATE INDEX completed_inbox_retention ON inbound_events(status,created_at);
CREATE INDEX audit_retention ON automation_audit(created_at);
