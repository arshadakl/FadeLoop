-- Organization is independent from automation configuration and delivery history.
CREATE TABLE automation_folders (
  folder_id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX automation_folders_name ON automation_folders(lower(name));
CREATE TABLE campaign_folders (
  campaign_id TEXT PRIMARY KEY REFERENCES campaigns(campaign_id) ON DELETE CASCADE,
  folder_id TEXT NOT NULL REFERENCES automation_folders(folder_id) ON DELETE CASCADE
);
CREATE INDEX campaign_folders_folder ON campaign_folders(folder_id);
CREATE TABLE campaign_trigger_activation (
  campaign_id TEXT PRIMARY KEY REFERENCES campaigns(campaign_id) ON DELETE CASCADE,
  activated_at INTEGER NOT NULL
);
