-- Mobile App Release (workflow templates, person/gate/watch steps, proof, stalled runs).
-- Additive only: existing workflows, steps and findings read exactly as before.

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS step_spec JSONB;

ALTER TABLE workflows ADD COLUMN IF NOT EXISTS template_ref JSONB;
ALTER TABLE workflows ADD COLUMN IF NOT EXISTS dry_run BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE workflows ADD COLUMN IF NOT EXISTS stall_snoozed_until TIMESTAMPTZ;
ALTER TABLE workflows ADD COLUMN IF NOT EXISTS stall_notified_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS workflow_watch_observations (
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
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT workflow_watch_source_check CHECK (source IN ('adapter','manual','dry_run'))
);
CREATE INDEX IF NOT EXISTS idx_workflow_watch_observations ON workflow_watch_observations(task_id, created_at);

CREATE TABLE IF NOT EXISTS workflow_watch_state (
    task_id UUID PRIMARY KEY NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    work_revision INTEGER NOT NULL,
    next_check_at TIMESTAMPTZ NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    started_at TIMESTAMPTZ NOT NULL,
    last_state TEXT
);

CREATE TABLE IF NOT EXISTS workflow_templates (
    id UUID PRIMARY KEY NOT NULL,
    container_id UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    base_key TEXT,
    base_version INTEGER,
    body JSONB NOT NULL,
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT workflow_templates_key_unique UNIQUE (container_id, key)
);

ALTER TABLE qa_findings ADD COLUMN IF NOT EXISTS lifecycle TEXT;
ALTER TABLE qa_findings ADD COLUMN IF NOT EXISTS fixed_ref TEXT;
ALTER TABLE qa_findings ADD COLUMN IF NOT EXISTS lifecycle_at TIMESTAMPTZ;
ALTER TABLE qa_findings ADD COLUMN IF NOT EXISTS lifecycle_by UUID;
