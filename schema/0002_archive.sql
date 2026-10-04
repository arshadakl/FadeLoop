-- Soft-delete for campaigns: archiving hides a campaign from the main list and stops it from
-- being polled, without deleting its history (unlike Delete, which is permanent — see db.ts).
ALTER TABLE campaigns ADD COLUMN archived_at INTEGER;
