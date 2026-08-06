/**
 * Phase 1 — a single thread's full view: messages, reply composer, resolve
 * button, and the "outdated — pinned to <sha7>" honesty chip when
 * blob_match=false (with a jump-to-pinned-sha link). Polls GET
 * /api/code/threads/{tid} on the house 3s bump so a tagged agent's reply
 * shows up without a manual refresh. Acting-human gated like every mutation
 * surface.
 *
 * Item 5 (post -> conversation right there): `seed` lets the caller mount
 * this view ALREADY populated with the thread + first message it just
 * created (ThreadRail passes the ThreadComposer's own POST response) — no
 * "Loading thread…" flash, no waiting for the next poll. Replies use the
 * same idea: a reply is appended to `detail.messages` immediately (an
 * `optimistic: true` local id), then reconciled — replaced by the server's
 * real row — once the POST resolves or the next 3s poll's fetchThread comes
 * back with the authoritative list (matched by body+author, since the
 * optimistic row has no real id yet).
 */
import { useEffect, useRef, useState } from "react";
import { relTime } from "../../lib/format";
import { useToast } from "../../components/ui";
import { actingHuman, useSnapshot } from "../../state/SnapshotProvider";
import { fetchThread, postThreadMessage } from "./codespaceApi";
import {
  anchorLabel,
  kindLabel,
  shortSha,
  type CodeThreadDetailPayload,
  type CodeThreadMessage,
} from "./codespaceTypes";

export interface ThreadViewProps {
  threadId: string;
  onBack: () => void;
  onJumpToPinnedSha?: (sha: string) => void;
  // Item 5 — optimistic seed: the just-created thread + its opening message,
  // so the rail can swap straight into this view with no loading flash.
  seed?: CodeThreadDetailPayload;
}

let optimisticSeq = 0;

export function ThreadView({ threadId, onBack, onJumpToPinnedSha, seed }: ThreadViewProps) {
  const { snap, bump } = useSnapshot();
  const toast = useToast();
  const [detail, setDetail] = useState<CodeThreadDetailPayload | null>(seed ?? null);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const token = useRef(0);
  const seededThreadId = useRef<string | null>(seed ? threadId : null);

  useEffect(() => {
    // A seed for THIS thread id already painted synchronously on mount —
    // skip the redundant first fetch so the seeded content doesn't flicker.
    if (seededThreadId.current === threadId) {
      seededThreadId.current = null;
      return;
    }
    const myToken = ++token.current;
    fetchThread(threadId).then((res) => {
      if (myToken !== token.current) return;
      if (res.ok) setDetail((prev) => reconcile(prev, res.data));
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
    const body = reply.trim() || (resolve ? "Resolved." : "");
    if (!resolve && !body) { toast("Write a reply first", "warn"); return; }
    setBusy(true);
    setReply("");

    // Optimistic append: the reply shows up in the thread immediately,
    // before the network round-trip completes.
    const optimisticId = "optimistic-" + (++optimisticSeq);
    const optimisticMessage: CodeThreadMessage = {
      id: optimisticId,
      author_agent_id: who.id,
      is_human: who.kind === "human",
      body,
      created_at: new Date().toISOString(),
    };
    setDetail((d) => (d ? { ...d, messages: [...d.messages, optimisticMessage] } : d));

    postThreadMessage(threadId, { body, actor_agent_id: who.id, resolve })
      .then((res) => {
        setBusy(false);
        if (!res.ok) {
          toast("Couldn't post" + (res.error.detail ? ": " + res.error.detail : ""), "danger");
          // roll back the optimistic row — the reply never actually landed.
          setDetail((d) => (d ? { ...d, messages: d.messages.filter((m) => m.id !== optimisticId) } : d));
          setReply(body);
          return;
        }
        // reconcile: swap the optimistic placeholder for the real message row.
        setDetail((d) => (d
          ? { thread: res.data.thread, messages: d.messages.map((m) => (m.id === optimisticId ? res.data.message : m)) }
          : d));
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
        {thread.request_id ? (
          // Item 2 (thread -> request direction): the request/wake payload
          // already links BACK to this thread (a plain "/code?..." path, since
          // the conversation UI's linkify only anchors http(s) URLs); this chip
          // closes the loop the other way — jump to the underlying request.
          <a className="cs-request-chip" href={"/requests?req=" + encodeURIComponent(thread.request_id)}>
            via request {thread.request_id.slice(0, 8)}
          </a>
        ) : null}
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
          <div key={m.id} className={"cs-message" + (m.is_human ? " human" : "") + (m.id.startsWith("optimistic-") ? " pending" : "")}>
            <div className="cs-message-meta">
              <span>{m.is_human ? "human" : m.author_alias || "agent"}</span>
              <span>{m.id.startsWith("optimistic-") ? "sending…" : relTime(m.created_at)}</span>
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

// Merge a freshly-fetched detail payload with whatever's currently on screen,
// preserving any still-in-flight optimistic messages the fetch raced past
// (an optimistic row is dropped once a same-body/same-author real message
// appears in the fetched list — the ordinary case is the fetch simply
// supersedes it entirely once the POST has landed server-side).
function reconcile(prev: CodeThreadDetailPayload | null, fetched: CodeThreadDetailPayload): CodeThreadDetailPayload {
  if (!prev) return fetched;
  const stillPending = prev.messages.filter((m) => {
    if (!m.id.startsWith("optimistic-")) return false;
    return !fetched.messages.some((fm) => fm.body === m.body && fm.author_agent_id === m.author_agent_id);
  });
  return { thread: fetched.thread, messages: [...fetched.messages, ...stillPending] };
}
