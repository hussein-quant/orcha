/**
 * Phase 1 — a single thread's full view: messages, reply composer, resolve
 * button, and the "outdated — pinned to <sha7>" honesty chip when
 * blob_match=false (with a jump-to-pinned-sha link). Polls GET
 * /api/code/threads/{tid} on the house 3s bump so a tagged agent's reply
 * shows up without a manual refresh. Acting-human gated like every mutation
 * surface.
 */
import { useEffect, useRef, useState } from "react";
import { relTime } from "../../lib/format";
import { useToast } from "../../components/ui";
import { actingHuman, useSnapshot } from "../../state/SnapshotProvider";
import { fetchThread, postThreadMessage } from "./codespaceApi";
import { anchorLabel, kindLabel, shortSha, type CodeThreadDetailPayload } from "./codespaceTypes";

export interface ThreadViewProps {
  threadId: string;
  onBack: () => void;
  onJumpToPinnedSha?: (sha: string) => void;
}

export function ThreadView({ threadId, onBack, onJumpToPinnedSha }: ThreadViewProps) {
  const { snap, bump } = useSnapshot();
  const toast = useToast();
  const [detail, setDetail] = useState<CodeThreadDetailPayload | null>(null);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const token = useRef(0);

  useEffect(() => {
    const myToken = ++token.current;
    fetchThread(threadId).then((res) => {
      if (myToken !== token.current) return;
      if (res.ok) setDetail(res.data);
    });
    // house 3s bump — polls the thread's messages without a manual refresh
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, bump]);

  if (!detail) return <div className="none" style={{ padding: 14 }}>Loading thread…</div>;
  const { thread, messages } = detail;
  const outdated = thread.blob_match === false;

  const submitReply = (resolve?: boolean) => {
    const who = actingHuman(snap);
    if (!who) { toast("Pick an acting human first", "warn"); return; }
    if (!resolve && !reply.trim()) { toast("Write a reply first", "warn"); return; }
    setBusy(true);
    postThreadMessage(threadId, { body: reply.trim() || (resolve ? "Resolved." : ""), actor_agent_id: who.id, resolve })
      .then((res) => {
        setBusy(false);
        if (!res.ok) {
          toast("Couldn't post" + (res.error.detail ? ": " + res.error.detail : ""), "danger");
          return;
        }
        setReply("");
        setDetail((d) => (d ? { thread: res.data.thread, messages: [...d.messages, res.data.message] } : d));
        toast(resolve ? "Thread resolved" : "Reply posted", "ok");
      });
  };

  return (
    <div className="cs-thread-view">
      <button type="button" className="cs-thread-back" onClick={onBack}>&larr; Back to threads</button>
      <div className="cs-thread-head">
        <div className="row1">
          <span className={"kind-tag " + thread.kind}>{kindLabel(thread.kind)}</span>
          <span className="anchor mono">{thread.path}:{anchorLabel(thread.start_line, thread.end_line)}</span>
        </div>
        <span className="status-tag">{thread.status}</span>
        {outdated ? (
          <div className="outdated-chip">
            outdated — pinned to {shortSha(thread.sha)}
            {onJumpToPinnedSha ? (
              <button type="button" className="cs-thread-back" onClick={() => onJumpToPinnedSha(thread.sha)}>
                jump to pinned sha
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="cs-messages">
        {messages.map((m) => (
          <div key={m.id} className={"cs-message" + (m.is_human ? " human" : "")}>
            <div className="cs-message-meta">
              <span>{m.is_human ? "human" : m.author_alias || "agent"}</span>
              <span>{relTime(m.created_at)}</span>
            </div>
            <div className="cs-message-body">{m.body}</div>
          </div>
        ))}
      </div>
      {thread.status !== "resolved" ? (
        <div className="cs-reply-row">
          <textarea
            className="cs-composer-body"
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            placeholder="Reply…"
            aria-label="Reply to thread"
          />
          <div className="cs-reply-actions">
            <button type="button" className="btn approve sm" disabled={busy} onClick={() => submitReply(false)}>
              Reply
            </button>
            <button type="button" className="btn ghost sm" disabled={busy} onClick={() => submitReply(true)}>
              Resolve
            </button>
          </div>
        </div>
      ) : (
        <div className="muted" style={{ fontSize: 12.5 }}>This thread is resolved.</div>
      )}
    </div>
  );
}
