-- 0011_perf_indexes.sql
-- High-performance composite indexes to eliminate correlated table scans and CPU spikes in Cloudflare Workers.

-- 1. Index hot queue queries for inbound events (generation, status, next_at, lease_until)
CREATE INDEX IF NOT EXISTS idx_inbound_events_dispatch 
ON inbound_events(generation, status, next_at, lease_until);

-- 2. Index outbox jobs by generation, status, next_at, and updated_at
CREATE INDEX IF NOT EXISTS idx_outbound_jobs_dispatch 
ON outbound_jobs(generation, status, next_at, updated_at);

-- 3. Composite index for recipient rate limit queries in dispatchOne
CREATE INDEX IF NOT EXISTS idx_send_attempts_rate_limit 
ON send_attempts(recipient, is_dm, dispatched_at);

-- 4. Fast single-column index for global dispatch time aggregation
CREATE INDEX IF NOT EXISTS idx_send_attempts_dispatched_at 
ON send_attempts(dispatched_at);
