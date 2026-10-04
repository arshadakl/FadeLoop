-- Kept across workspace resets; stale invocations must never regain write access.
CREATE TABLE instagram_connection_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  generation INTEGER NOT NULL CHECK (generation >= 0)
);
INSERT INTO instagram_connection_state (id, generation) VALUES (1, 0);
