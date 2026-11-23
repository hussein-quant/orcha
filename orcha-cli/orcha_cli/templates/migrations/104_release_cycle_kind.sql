-- A release cycle is a planned release (cut from main) or a hotfix (cut from what's live, with
-- only the fixes it needs). Additive: every existing cycle is a planned release.
ALTER TABLE release_cycles ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'release';
