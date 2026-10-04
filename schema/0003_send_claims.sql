-- Send claims: an at-most-once guard for outbound DMs.
--
-- Every outbound send is claimed here BEFORE it goes out. If a send's outcome is ambiguous
-- (timeout, dropped connection, 5xx after Instagram already processed it) the claim is left in
-- place, so a later retry finds it and skips the send instead of delivering the same DM twice.
-- Claims are released only when the platform definitively rejected the request (4xx), which
-- means nothing was delivered and retrying is safe.
CREATE TABLE IF NOT EXISTS send_claims (
  key        TEXT PRIMARY KEY,      -- e.g. "opening:c1:<comment-id>", "follow_gate:c1:<igsid>"
  created_at INTEGER NOT NULL
);
