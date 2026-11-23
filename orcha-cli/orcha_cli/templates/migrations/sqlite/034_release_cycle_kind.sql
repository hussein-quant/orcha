-- A release cycle is a planned release (cut from main) or a hotfix (cut from what's live, with
-- only the fixes it needs). Additive: every existing cycle is a planned release.
ALTER TABLE release_cycles ADD COLUMN kind TEXT NOT NULL DEFAULT 'release';

INSERT OR IGNORE INTO schema_migrations (version)
VALUES ('034_release_cycle_kind.sql'), ('104_release_cycle_kind.sql');
