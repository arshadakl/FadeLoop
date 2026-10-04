-- Dashboard login is independent from the existing Instagram OAuth credentials.
CREATE TABLE owner_accounts (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  credential_version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
CREATE TABLE owner_sessions (
  token_hash TEXT PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
  credential_version INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX owner_sessions_expiry ON owner_sessions(expires_at);
CREATE TABLE login_throttles (
  bucket TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX login_throttles_expiry ON login_throttles(expires_at);
CREATE TABLE owner_oauth_states (
  state_hash TEXT PRIMARY KEY,
  session_hash TEXT NOT NULL REFERENCES owner_sessions(token_hash) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
