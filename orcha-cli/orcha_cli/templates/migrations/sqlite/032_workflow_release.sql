-- Mobile App Release (workflow templates, person/gate/watch steps, proof, stalled runs).
-- Additive only: existing workflows, steps and findings read exactly as before.

-- A step's kind and its spec (workflow_steps.py): {kind, stage, person_id, watch, gate,
-- irreversible, resources, platforms, build, scope, dry_run}. NULL = a classic agent/QA step.
ALTER TABLE tasks ADD COLUMN step_spec JSONB;

-- The template a workflow was made from, its parameters, and the dry-run switch.
ALTER TABLE workflows ADD COLUMN template_ref JSONB;
ALTER TABLE workflows ADD COLUMN dry_run BOOLEAN NOT NULL DEFAULT false;
-- Stalled detection (no step progress for N days): snooze and the one notification sent.
ALTER TABLE workflows ADD COLUMN stall_snoozed_until TIMESTAMPTZ;
ALTER TABLE workflows ADD COLUMN stall_notified_at TIMESTAMPTZ;

-- Every reading a watch step took of an outside status (store review, build processing).
CREATE TABLE workflow_watch_observations (
    id UUID PRIMARY KEY NOT NULL,
    workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    work_revision INTEGER NOT NULL,
    state TEXT NOT NULL,
    terminal BOOLEAN NOT NULL DEFAULT false,
    summary TEXT NOT NULL DEFAULT '',
    detail_url TEXT,
    data JSONB,
    source TEXT NOT NULL DEFAULT 'adapter',
    error TEXT,
    observed_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000+00:00'),
    CONSTRAINT workflow_watch_source_check CHECK (source IN ('adapter','manual','dry_run'))
);
CREATE INDEX idx_workflow_watch_observations ON workflow_watch_observations(task_id, created_at);

-- When each watch step is next due, and how many readings it has taken this revision.
CREATE TABLE workflow_watch_state (
    task_id UUID PRIMARY KEY NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    work_revision INTEGER NOT NULL,
    next_check_at TIMESTAMPTZ NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    started_at TIMESTAMPTZ NOT NULL,
    last_state TEXT
);

-- A project's own copies of a template ("Nyumbani release"), imported or saved from the
-- editor. Built-in templates live in code (workflow_templates.py) and are never stored.
CREATE TABLE workflow_templates (
    id UUID PRIMARY KEY NOT NULL,
    container_id UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    base_key TEXT,
    base_version INTEGER,
    body JSONB NOT NULL,
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000+00:00'),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000+00:00'),
    CONSTRAINT workflow_templates_key_unique UNIQUE (container_id, key)
);

-- A finding's fix: open -> fixed (by a PR or commit) -> verified (a re-run passed). The
-- existing status (open / filed / dismissed) is unchanged; this records the fix beside it.
ALTER TABLE qa_findings ADD COLUMN lifecycle TEXT;
ALTER TABLE qa_findings ADD COLUMN fixed_ref TEXT;
ALTER TABLE qa_findings ADD COLUMN lifecycle_at TIMESTAMPTZ;
ALTER TABLE qa_findings ADD COLUMN lifecycle_by UUID;

INSERT OR IGNORE INTO schema_migrations (version)
VALUES ('032_workflow_release.sql'), ('102_workflow_release.sql');
