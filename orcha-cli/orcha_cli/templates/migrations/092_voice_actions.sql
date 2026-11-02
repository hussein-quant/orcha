-- GH #409: Voice-first mode. One row per action the owner took by voice: a decision on
-- something that needed them (plan / verify / request) or project work from a conversation
-- (task: create / assign / message). It keeps the transcript, the single structured action
-- and what the route did with it. The action itself still goes through the normal route;
-- decision routes link back here (events.detail.voice_action_id). item_id is NULL only for a
-- task that is being created.
CREATE TABLE voice_actions (
    id UUID PRIMARY KEY,
    container_id UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    actor_agent_id UUID NOT NULL REFERENCES agents(id),
    idempotency_key TEXT NOT NULL,
    item_kind TEXT NOT NULL CONSTRAINT voice_actions_item_kind_check CHECK (item_kind IN ('plan','verify','request','task')),
    item_id UUID,
    action TEXT NOT NULL,
    transcript TEXT NOT NULL,
    intent TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CONSTRAINT voice_actions_status_check CHECK (status IN ('pending','done','undone','failed')),
    result TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ,
    CONSTRAINT voice_actions_key_unique UNIQUE (container_id, actor_agent_id, idempotency_key)
);
CREATE INDEX voice_actions_item ON voice_actions(container_id, item_kind, item_id);
