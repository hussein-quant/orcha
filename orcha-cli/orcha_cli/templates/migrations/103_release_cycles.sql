-- Release cycles: a release/x.y.z branch that collects tickets for two or three weeks, each built,
-- merged by a person and checked on staging in its own small workflow, then cut into one release.
-- Additive only: workflows, templates and releases read exactly as before.

CREATE TABLE IF NOT EXISTS release_cycles (
    id UUID PRIMARY KEY NOT NULL,
    container_id UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    version TEXT NOT NULL,
    branch TEXT NOT NULL,
    base_branch TEXT NOT NULL DEFAULT 'main',
    milestone TEXT,
    state TEXT NOT NULL DEFAULT 'open',
    -- The platforms this project ships; a ticket names its own.
    platforms JSONB NOT NULL,
    -- Who does what for every ticket: {engineer, release, qa}, and an engineer per platform.
    roles JSONB,
    engineers JSONB,
    dry_run BOOLEAN NOT NULL DEFAULT false,
    -- Whether the release branch exists on origin: pending, created, existed, failed, skipped.
    branch_state TEXT NOT NULL DEFAULT 'pending',
    branch_note TEXT,
    release_workflow_id UUID REFERENCES workflows(id) ON DELETE SET NULL,
    previous_cycle_id UUID,
    next_cycle_id UUID,
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    cut_at TIMESTAMPTZ,
    cut_by UUID,
    CONSTRAINT release_cycles_state_check CHECK (state IN ('open','cut','closed')),
    CONSTRAINT release_cycles_branch_state_check CHECK (branch_state IN ('pending','created','existed','failed','skipped'))
);
CREATE INDEX IF NOT EXISTS idx_release_cycles_container ON release_cycles(container_id, created_at);

CREATE TABLE IF NOT EXISTS release_cycle_tickets (
    id UUID PRIMARY KEY NOT NULL,
    cycle_id UUID NOT NULL REFERENCES release_cycles(id) ON DELETE CASCADE,
    container_id UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    workflow_id UUID REFERENCES workflows(id) ON DELETE SET NULL,
    issue_number INTEGER,
    issue_url TEXT,
    title TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'bug',
    platforms JSONB NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual',
    -- active while it's being built; shipped once a cut took it; dropped when a person took it out.
    state TEXT NOT NULL DEFAULT 'active',
    rolled_from_cycle_id UUID,
    added_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT release_cycle_tickets_kind_check CHECK (kind IN ('bug','feature')),
    CONSTRAINT release_cycle_tickets_source_check CHECK (source IN ('manual','github')),
    CONSTRAINT release_cycle_tickets_state_check CHECK (state IN ('active','shipped','dropped'))
);
CREATE INDEX IF NOT EXISTS idx_release_cycle_tickets_cycle ON release_cycle_tickets(cycle_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_release_cycle_tickets_issue ON release_cycle_tickets(cycle_id, issue_number)
    WHERE issue_number IS NOT NULL;
