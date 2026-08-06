/**
 * Phase 1 — the thread composer: one-click kind templates ("How does this
 * work?" / "Why this decision?" / "Teach me this concept" / plain note),
 * @agent picker (container AI agents from the snapshot), and the POST per
 * spec (docs/orcha-code-space-design.md's Phase 1 API). Acting-human gated
 * like every mutation surface (postStart/postStop precedent).
 *
 * Also reused by Phase 2's "raise hand" flow (LivePanel.tsx): pre-tagged at
 * the run's agent, with the honest "queued — the agent addresses this at its
 * next checkpoint" caption instead of a free @agent picker.
 */
import { useState } from "react";
import { useToast } from "../../components/ui";
import { actingHuman, useSnapshot } from "../../state/SnapshotProvider";
import type { Agent } from "../../types";
import { createThread } from "./codespaceApi";
import { anchorLabel, THREAD_TEMPLATES, type ThreadKind } from "./codespaceTypes";

export interface ThreadComposerProps {
  cid: string;
  // NOT named "ref" — that's a reserved JSX/React prop (element refs); see
  // RepoBrowser.tsx's identical convention/comment for `gitRef`.
  gitRef: string;
  path: string;
  startLine: number;
  endLine: number;
  agents: Agent[];
  // Phase 2 raise-hand: pre-tag a specific agent and lock the picker, with
  // the honest queued-caption instead of the free picker.
  preTaggedAgentId?: string | null;
  onCreated?: (threadId: string) => void;
  onCancel?: () => void;
}

export function ThreadComposer({
  cid,
  gitRef,
  path,
  startLine,
  endLine,
  agents,
  preTaggedAgentId,
  onCreated,
  onCancel,
}: ThreadComposerProps) {
  const { snap } = useSnapshot();
  const toast = useToast();
  const [kind, setKind] = useState<ThreadKind>("question");
  const [body, setBody] = useState(THREAD_TEMPLATES[0].starterBody);
  const [taggedAgentId, setTaggedAgentId] = useState<string>(preTaggedAgentId || "");
  const [busy, setBusy] = useState(false);

  const aiAgents = agents.filter((a) => a.kind === "ai");
  const raiseHand = !!preTaggedAgentId;

  const pickTemplate = (t: (typeof THREAD_TEMPLATES)[number]) => {
    setKind(t.kind);
    setBody(t.starterBody);
  };

  const submit = () => {
    const who = actingHuman(snap);
    if (!who) { toast("Pick an acting human first", "warn"); return; }
    if (!body.trim()) { toast("Write something first", "warn"); return; }
    setBusy(true);
    createThread(cid, {
      ref: gitRef,
      path,
      start_line: startLine,
      end_line: endLine,
      kind,
      body: body.trim(),
      tagged_agent_id: taggedAgentId || undefined,
      actor_agent_id: who.id,
    }).then((res) => {
      setBusy(false);
      if (!res.ok) {
        toast("Couldn't post thread" + (res.error.detail ? ": " + res.error.detail : ""), "danger");
        return;
      }
      toast("Thread posted", "ok");
      onCreated?.(res.data.thread.id);
    });
  };

  return (
    <div className="cs-composer">
      <div className="cs-composer-anchor">
        {path} · line {anchorLabel(startLine, endLine)}
      </div>
      {!raiseHand ? (
        <div className="cs-templates" role="group" aria-label="Question templates">
          {THREAD_TEMPLATES.map((t) => (
            <button
              key={t.kind}
              type="button"
              className={"cs-template-btn" + (kind === t.kind ? " on" : "")}
              onClick={() => pickTemplate(t)}
            >
              {t.label}
            </button>
          ))}
        </div>
      ) : (
        <div className="cs-raise-hand-caption">queued — the agent addresses this at its next checkpoint</div>
      )}
      <textarea
        className="cs-composer-body"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Write your message…"
        aria-label="Thread message"
      />
      <div className="cs-composer-row">
        {!raiseHand ? (
          <select
            className="cs-agent-select"
            value={taggedAgentId}
            aria-label="Tag an agent"
            onChange={(e) => setTaggedAgentId(e.target.value)}
          >
            <option value="">No @agent tag</option>
            {aiAgents.map((a) => (
              <option key={a.id} value={a.id}>@{a.alias}</option>
            ))}
          </select>
        ) : (
          <span className="cs-agent-select muted" aria-hidden="true">
            @{(aiAgents.find((a) => a.id === preTaggedAgentId) || { alias: "agent" }).alias}
          </span>
        )}
        {onCancel ? (
          <button type="button" className="btn ghost sm" onClick={onCancel}>Cancel</button>
        ) : null}
        <button type="button" className="btn approve sm" disabled={busy} onClick={submit}>
          {busy ? "Posting…" : "Post"}
        </button>
      </div>
    </div>
  );
}
