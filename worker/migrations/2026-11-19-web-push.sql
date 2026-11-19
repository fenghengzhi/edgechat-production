CREATE TABLE IF NOT EXISTS web_push_subscriptions (
  endpoint_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_hash TEXT NOT NULL,
  device_session_id TEXT REFERENCES device_sessions(id) ON DELETE CASCADE,
  session_version INTEGER NOT NULL,
  valid_until INTEGER NOT NULL,
  subscription TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_web_push_user ON web_push_subscriptions(user_id, valid_until);
