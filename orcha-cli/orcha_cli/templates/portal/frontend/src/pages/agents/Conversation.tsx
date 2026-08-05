/**
 * S1 conversation panel (+ S4 slash autocomplete, S5 presence, #337
 * attachments) — React port of static/conversation.js for one agent. The
 * component is remounted per agent (key={agent.id}) which mirrors the vanilla
 * mount()/teardown() lifecycle; all composer state lives in useState so the 3s
 * poll never clobbers typing.
 *
 * Contracts (Vault conv-store #115 — STABLE, copied exactly):
 *   POST /api/agents/{aid}/conversations {actor_agent_id}        get-or-create
 *   GET  /api/agents/{aid}/conversation?limit=N                  {conversation, turns}
 *   GET  /api/conversations/{cid}/turns?after_seq=S&limit=N      {turns} (oldest->newest)
 *   GET  /api/conversations/{cid}                                 presence refresh
 *   POST /api/conversations/{cid}/turns {role,author_agent_id,content,attachments?}
 *   POST /api/conversations/{cid}/attachments                     multipart upload
 *
 * The live terminal ("Pair in terminal", S3 §3b) is the React port of the
 * conversation.js pairing half — see components/terminal/TerminalPane
 * (usePairing) on top of the OrchaTerm engine port (terminal.js contract,
 * UNCHANGED).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useCallback, useEffect, useRef, useState } from "react";
import { getJSON } from "../../api/client";
import { usePairing } from "../../components/terminal/TerminalPane";
import { Avatar, Icon, Md, useToast } from "../../components/ui";
import { relTime } from "../../lib/format";
import { leaseOf } from "../../lib/status";
import { actingHuman, agentById, useSnapshot } from "../../state/SnapshotProvider";
import type { Agent, Snapshot } from "../../types";
import { WorkLogDetails } from "./runlog";

interface ConvAtt {
  id?: string;
  url?: string;
  name?: string;
  size?: number;
  kind?: string;
}
interface ConvTurn {
  seq: number;
  role: string;
  author_agent_id?: string | null;
  content?: string;
  created_at?: string;
  run_id?: string | null;
  meta?: any;
  attachments?: ConvAtt[];
}
interface Staged {
  key: number;
  name: string;
  size: number;
  kind: string;
  status: "uploading" | "done" | "failed";
  ref?: any;
}

// the /-palette mirrors the CLI work skills (presentational; sends as turn content)
const SKILLS = [
  "/orcha-status", "/orcha-next", "/orcha-task-new", "/orcha-post", "/orcha-done",
  "/orcha-ask", "/orcha-inbox", "/orcha-outbox", "/orcha-respond", "/orcha-close",
  "/orcha-escalate", "/orcha-convert", "/orcha-accept-task", "/orcha-reject-task",
];

const ACCEPT_EXT = ["png", "jpg", "jpeg", "gif", "webp", "pdf", "txt", "md", "csv", "log", "json"];
const IMG_EXT = ["png", "jpg", "jpeg", "gif", "webp"];
const extOf = (n: unknown) => (String(n || "").split(".").pop() || "").toLowerCase();
const CLIP_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>';
const FILE_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>';
function fmtSize(n: unknown): string {
  const v = +(n as number) || 0;
  if (v < 1024) return v + " B";
  if (v < 1024 * 1024) return (v / 1024).toFixed(v < 10240 ? 1 : 0) + " KB";
  return (v / (1024 * 1024)).toFixed(1) + " MB";
}

const PRES_LABEL: Record<string, string> = { idle: "idle", waking: "waking", working: "working", busy: "busy", replied: "replied", stopped: "offline" };

// ISS-68: per-agent conversation cache so switching agent tabs and back does
// NOT reload the thread from scratch. Module-level, mirrors the vanilla cache.
const convCache: Record<
  string,
  { convId: string | null; convStatus: string | null; turns: ConvTurn[]; lastSeq: number; presence: string | null; presenceReason: string | null; at: number }
> = {};
const CONV_CACHE_TTL_MS = 60000;
const CONV_PAGE = 20;

/* ---------- ISS-64: persist the composer draft across navigation ---------- */
const draftKey = (aid: string) => "orcha:convdraft:" + aid;
function saveDraft(aid: string, v: string): void {
  try {
    if (v) sessionStorage.setItem(draftKey(aid), v);
    else sessionStorage.removeItem(draftKey(aid));
  } catch { /* private mode */ }
}
function loadDraft(aid: string): string {
  try {
    return sessionStorage.getItem(draftKey(aid)) || "";
  } catch {
    return "";
  }
}

function presenceOf(
  presence: string | null,
  presenceReason: string | null,
  convStatus: string | null,
  agent: Agent,
): { k: string; l: string; reason?: string | null } {
  if (presence != null) { // backend is talking — trust it
    const known = Object.prototype.hasOwnProperty.call(PRES_LABEL, presence);
    const l = known ? PRES_LABEL[presence] : "idle"; // forward-compat: unknown -> idle
    const k = known && presence === "stopped" ? "offline" : known ? presence : "idle";
    return { k, l, reason: presenceReason || null };
  }
  if (convStatus === "ended") return { k: "offline", l: "offline" };
  switch (agent.status) {
    case "working":
    case "in_progress":
      return { k: "working", l: "working" };
    case "awaiting_human":
    case "awaiting_request":
      return { k: "waking", l: "waiting" };
    case "needs_verification":
      return { k: "replied", l: "replied" };
    case "terminated":
      return { k: "offline", l: "offline" };
    default:
      return { k: "idle", l: "idle" };
  }
}

function AttRow({ a, onZoom }: { a: ConvAtt; onZoom: (url: string) => void }) {
  const url = a.url || "";
  const nm = a.name || a.id || "file";
  if (a.kind === "image") {
    return <img className="att-img" src={url} alt={nm} title={nm} loading="lazy" onClick={() => onZoom(url)} />;
  }
  return (
    <a className="att-file" href={url} target="_blank" rel="noopener" download>
      <span style={{ display: "contents" }} dangerouslySetInnerHTML={{ __html: FILE_ICON }} />
      <span>{nm}</span>
      <span className="sz">{fmtSize(a.size)}</span>
    </a>
  );
}

// PR2/E4 will make these interactive; render the affordance forward-compatibly.
function GateCardBubble({ meta }: { meta: any }) {
  if (meta.type === "permission_request") {
    return (
      <div className="gcard perm">
        <div className="gh">
          <Icon name="shield" cls="" />
          Permission requested{meta.tool_name ? " · " + meta.tool_name : ""}
        </div>
        {meta.tool_input ? <pre className="gpre">{typeof meta.tool_input === "string" ? meta.tool_input : JSON.stringify(meta.tool_input, null, 2)}</pre> : null}
        <div className="gnote">Allow / deny lands with E4.</div>
      </div>
    );
  }
  return (
    <div className="gcard ask">
      <div className="gh">
        <Icon name="spark" cls="" />
        {meta.question || "Needs an answer"}
      </div>
      <div className="gnote">Reply lands with E4.</div>
    </div>
  );
}

function Bubble({ t, snap, agentId, onZoom }: { t: ConvTurn; snap: Snapshot | null; agentId: string; onZoom: (url: string) => void }) {
  const human = t.role === "human";
  const a = agentById(snap, t.author_agent_id);
  const meta = t.meta || {};
  const card = !human && (meta.type === "permission_request" || meta.type === "ask_human");
  const atts = t.attachments || [];
  return (
    <div className={"turn " + (human ? "human" : "agent")}>
      {!human && <Avatar alias={a ? a.alias : "?"} kind="ai" size="sm" />}
      <div className="tb">
        <div className="tmeta">
          {human ? "you" : a ? a.alias : "agent"}
          <span className="tt">{t.created_at ? relTime(t.created_at) : ""}</span>
        </div>
        {card ? <GateCardBubble meta={meta} /> : <Md className="tx md" text={t.content || ""} tasks={snap?.tasks ?? []} />}
        {atts.length > 0 && (
          <div className="msg-atts">
            {atts.map((att, i) => (
              <AttRow key={att.id || i} a={att} onZoom={onZoom} />
            ))}
          </div>
        )}
        {!human && t.run_id ? <WorkLogDetails agentId={agentId} runId={String(t.run_id)} /> : null}
      </div>
    </div>
  );
}

export function Conversation({ agent }: { agent: Agent }) {
  const { snap } = useSnapshot();
  const toast = useToast();

  // ISS-68: rehydrate a fresh cache instantly (no flicker on tab switch).
  const cached = convCache[agent.id];
  const freshCache = cached && Date.now() - cached.at < CONV_CACHE_TTL_MS ? cached : null;
  const [convId, setConvId] = useState<string | null>(freshCache ? freshCache.convId : null);
  const [convStatus, setConvStatus] = useState<string | null>(freshCache ? freshCache.convStatus : null);
  const [turns, setTurns] = useState<ConvTurn[]>(freshCache ? freshCache.turns.slice() : []);
  const [loaded, setLoaded] = useState(!!freshCache);
  const [unavailable, setUnavailable] = useState(false);
  const [shown, setShown] = useState(10); // ISS-68 PR-3: most-recent 10 first; "Load earlier" reveals more
  const [awaiting, setAwaiting] = useState(false); // optimistic until the reply lands
  const [presence, setPresence] = useState<string | null>(freshCache ? freshCache.presence : null);
  const [presenceReason, setPresenceReason] = useState<string | null>(freshCache ? freshCache.presenceReason : null);
  const [draft, setDraftRaw] = useState(() => loadDraft(agent.id)); // ISS-64 rehydrate
  const [staged, setStaged] = useState<Staged[]>([]);
  const [slashIdx, setSlashIdx] = useState(0);
  const [slashClosed, setSlashClosed] = useState(false);
  const [dragover, setDragover] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);

  // S3 §3b live terminal pairing — owns paired/termConnected, the docked
  // terminal pane, the preempt/not-installed modals, and the ISS-65 maximize
  // state (exclusive across conv/term, mirroring the vanilla `maxed`).
  const pairing = usePairing(agent);
  const maxed = pairing.maxed === "conv"; // this panel's maximized state

  const convIdRef = useRef<string | null>(freshCache ? freshCache.convId : null);
  const lastSeqRef = useRef<number>(freshCache ? freshCache.lastSeq : 0);
  const stagedSeqRef = useRef(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const setDraft = (v: string) => {
    setDraftRaw(v);
    saveDraft(agent.id, v); // ISS-64: persist on every keystroke
  };

  /* ---------- load + poll ---------- */
  const load = useCallback(async () => {
    try {
      const d: any = await getJSON("/api/agents/" + encodeURIComponent(agent.id) + "/conversation?limit=50");
      convIdRef.current = d.conversation ? d.conversation.id : null;
      setConvId(convIdRef.current);
      setConvStatus(d.conversation ? d.conversation.status || null : null);
      setPresence(d.presence || null);
      setPresenceReason(d.presence_reason || null); // top-level (Vault)
      const t: ConvTurn[] = d.turns || [];
      setTurns(t);
      lastSeqRef.current = t.length ? t[t.length - 1].seq : 0;
      setLoaded(true);
      setUnavailable(false);
    } catch {
      setUnavailable(true);
      setLoaded(true);
    }
  }, [agent.id]);

  const refreshPresence = useCallback((cid: string) => {
    // presence + presence_reason ride on GET /api/conversations/{id}; if the
    // endpoint/field isn't live yet this no-ops and we fall back to agent.status.
    getJSON<any>("/api/conversations/" + encodeURIComponent(cid))
      .then((d) => {
        setPresence(d.presence || null);
        setPresenceReason(d.presence_reason || null);
      })
      .catch(() => { /* not live yet -> keep status-derived */ });
  }, []);

  const poll = useCallback(async () => {
    const cid = convIdRef.current;
    if (!cid) {
      void load();
      return;
    }
    refreshPresence(cid);
    try {
      const d: any = await getJSON("/api/conversations/" + encodeURIComponent(cid) + "/turns?after_seq=" + lastSeqRef.current + "&limit=50");
      const fresh: ConvTurn[] = d.turns || [];
      if (!fresh.length) return;
      if (fresh.some((t) => t.role === "agent")) setAwaiting(false); // reply landed -> stop "thinking"
      setTurns((prev) => {
        const next = prev.concat(fresh);
        lastSeqRef.current = next[next.length - 1].seq;
        return next;
      });
    } catch { /* transient */ }
  }, [load, refreshPresence]);

  useEffect(() => {
    if (freshCache) void poll(); // background top-up via after_seq (append, not reload)
    else void load();
    const iv = setInterval(() => void poll(), 3000);
    return () => clearInterval(iv);
    // per-mount: the component is keyed by agent.id upstream
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // keep the ISS-68 cache current
  useEffect(() => {
    convCache[agent.id] = {
      convId: convIdRef.current,
      convStatus,
      turns: turns.slice(),
      lastSeq: lastSeqRef.current,
      presence,
      presenceReason,
      at: Date.now(),
    };
  }, [agent.id, convId, convStatus, turns, presence, presenceReason]);

  // autoscroll: stick to the bottom while the reader is at the bottom
  useEffect(() => {
    const list = listRef.current;
    if (list && atBottomRef.current) list.scrollTop = list.scrollHeight;
  }, [turns, awaiting, presence, shown]);

  // autosize the textarea (vanilla autosize())
  useEffect(() => {
    const inp = taRef.current;
    if (!inp) return;
    inp.style.height = "auto";
    inp.style.height = Math.min(inp.scrollHeight, 160) + "px";
  }, [draft]);

  // ISS-65: Escape + the shared backdrop live in usePairing (one maximize
  // system across the conversation and the docked terminal, like vanilla).

  // #337 lightbox: Escape closes
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLightbox(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [lightbox]);

  /* ---------- get-or-create ---------- */
  const ensureConv = async (): Promise<{ ok: boolean; status?: number; noHuman?: boolean }> => {
    if (convIdRef.current) return { ok: true };
    const h = actingHuman(snap);
    if (!h) return { ok: false, noHuman: true };
    const r = await fetch("/api/agents/" + encodeURIComponent(agent.id) + "/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actor_agent_id: h.id }),
    });
    if (!r.ok) return { ok: false, status: r.status };
    const c: any = await r.json();
    convIdRef.current = (c.conversation || c).id || convIdRef.current;
    setConvId(convIdRef.current);
    return { ok: true };
  };

  /* ---------- #337 attachments ---------- */
  const uploadConvFiles = (files: FileList | File[] | null | undefined) => {
    const valid = Array.from(files || []).filter((f) => {
      if (f && ACCEPT_EXT.includes(extOf(f.name))) return true;
      toast("Unsupported file type: " + ((f && f.name) || "file"), "danger");
      return false;
    });
    if (!valid.length) return;
    void ensureConv().then((res) => {
      if (!res.ok) {
        toast(res.noHuman ? "Pick an acting human (top-right) first." : "Couldn't open conversation (" + (res.status || "") + ")", "danger");
        return;
      }
      const cid = convIdRef.current as string; // pin the conversation each file uploads to
      valid.forEach((f) => {
        const key = ++stagedSeqRef.current;
        setStaged((s) => [...s, { key, name: f.name, size: f.size, kind: IMG_EXT.includes(extOf(f.name)) ? "image" : "file", status: "uploading" }]);
        const fd = new FormData();
        fd.append("file", f, f.name);
        fetch("/api/conversations/" + encodeURIComponent(cid) + "/attachments", { method: "POST", body: fd })
          .then((r) => (r.ok ? r.json() : r.json().then((d: any) => Promise.reject(d.detail || "HTTP " + r.status))))
          .then((ref: any) => setStaged((s) => s.map((x) => (x.key === key ? { ...x, status: "done", ref, size: ref.size, kind: ref.kind } : x))))
          .catch((err) => {
            setStaged((s) => s.map((x) => (x.key === key ? { ...x, status: "failed" } : x)));
            toast("Upload failed: " + (err || f.name), "danger");
          });
      });
    });
  };

  /* ---------- composer ---------- */
  const send = async () => {
    const v = draft.trim();
    const done = staged.filter((s) => s.status === "done");
    if (staged.some((s) => s.status === "uploading")) {
      toast("Wait for uploads to finish", "danger");
      return;
    }
    if (!v && !done.length) return; // #337: allow attachment-only turns
    const h = actingHuman(snap);
    if (!h) {
      toast("Pick an acting human (top-right) first.", "danger");
      return;
    }
    setSlashClosed(true);
    const atts = done.map((s) => ({ id: s.ref.id, name: s.ref.name }));
    const res = await ensureConv();
    if (!res.ok) {
      toast("Couldn't open conversation (" + (res.status || "") + ")", "danger");
      return;
    }
    const r = await fetch("/api/conversations/" + encodeURIComponent(convIdRef.current as string) + "/turns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "human", author_agent_id: h.id, content: v, attachments: atts.length ? atts : undefined }),
    });
    if (!r.ok) {
      toast("Send failed (" + r.status + ")", "danger");
      return;
    }
    setDraft(""); // ISS-64: drop the persisted draft once sent
    setStaged([]); // #337: clear the staging tray once sent
    toast("Sent — " + agent.alias + " will reply.", "ok");
    setAwaiting(true); // show the "thinking…" indicator until the reply lands
    void poll();
  };

  /* ---------- S4 slash palette (derived) ---------- */
  const slashQuery = draft.startsWith("/") && !draft.includes(" ") ? draft : null;
  const slashItems = slashQuery ? SKILLS.filter((s) => s.startsWith(slashQuery)) : [];
  const slashOpen = !!slashQuery && slashItems.length > 0 && !slashClosed;
  const pickSlash = (s: string) => {
    setDraft(s + " ");
    setSlashClosed(true);
    taRef.current?.focus();
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashOpen) {
      if (e.key === "ArrowDown") { e.preventDefault(); setSlashIdx((i) => (i + 1) % slashItems.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setSlashIdx((i) => (i - 1 + slashItems.length) % slashItems.length); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pickSlash(slashItems[slashIdx % slashItems.length]); return; }
      if (e.key === "Escape") { setSlashClosed(true); return; }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  /* ---------- derived render state ---------- */
  const p = presenceOf(presence, presenceReason, convStatus, agent);
  const awaitingReply = awaiting || (turns.length > 0 && turns[turns.length - 1].role === "human");
  // §3b vice-versa lock: while a `live` lease is held — our OWN connected pair
  // session, or another embodiment (from the read payload) — the conversation
  // is READ-ONLY. NOT while the panel is merely connecting/errored, so a
  // bridge-down panel doesn't wrongly freeze the composer.
  const locked = (pairing.paired && pairing.termConnected) || leaseOf(agent) === "live";
  const startIdx = Math.max(0, turns.length - shown);
  const visible = turns.slice(startIdx);

  const indicator = () => {
    // resident actively working the human's turn → thinking dots; busy on another
    // (task) lease → an honest "queued" notice (never fake "thinking…").
    if (p.k === "busy") return queued();
    if (p.k === "working" || p.k === "waking") return thinking();
    if (awaiting && p.k === "idle") return thinking();
    return queued();
  };
  const thinking = () => (
    <div className="turn agent">
      <Avatar alias={agent.alias} kind="ai" size="sm" />
      <div className="tb">
        <div className="tmeta">
          {agent.alias}
          <span className="tt">thinking…</span>
        </div>
        <div className="conv-thinking">
          <span />
          <span />
          <span />
        </div>
      </div>
    </div>
  );
  const queued = () => {
    const msg = p.reason ? p.reason : agent.alias + " is busy with another task — your message is queued and will be answered when it's free.";
    return (
      <div className="turn agent">
        <Avatar alias={agent.alias} kind="ai" size="sm" />
        <div className="tb">
          <div className="tmeta">
            {agent.alias}
            <span className="tt">queued</span>
          </div>
          <div className="conv-queued">
            <Icon name="clock" cls="" />
            <span>{msg}</span>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className={"conv-wrap" + (pairing.paired ? " paired" : "")} id="convPairWrap">
      <div
        className={"conv" + (dragover ? " dragover" : "") + (maxed ? " maximized" : "")}
        onDragEnter={(e) => { e.preventDefault(); setDragover(true); }}
        onDragOver={(e) => { e.preventDefault(); setDragover(true); }}
        onDragLeave={(e) => { e.preventDefault(); if (e.target === e.currentTarget) setDragover(false); }}
        onDrop={(e) => {
          e.preventDefault();
          setDragover(false);
          if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) uploadConvFiles(e.dataTransfer.files);
        }}
      >
        <div className="conv-h">
          <div className="conv-who">
            <Avatar alias={agent.alias} kind="ai" />
            <div>
              <div className="cn">{agent.alias}</div>
              <div className="cr">{agent.role || ""}</div>
            </div>
          </div>
          <span className={"presence p-" + p.k} id="convPresence">
            <span className="d" />
            {p.l}
          </span>
          {/* S3 §3b: dock a live xterm session (Forge PTY ws bridge) beside the
              thread; lease-guarded + ISS-84 preflight-gated (usePairing). */}
          <button
            className={"btn sm" + (pairing.paired ? "" : " ghost")}
            id="convPair"
            type="button"
            title={`Pair in a live terminal as ${agent.alias}`}
            onClick={pairing.togglePair}
          >
            <Icon name="play" cls="" />
            <span>{pairing.paired ? "Terminal paired" : "Pair in terminal"}</span>
          </button>
          <button
            className="btn sm ghost conv-max"
            id="convMax"
            type="button"
            title={maxed ? "Restore conversation" : "Maximize conversation"}
            onClick={() => pairing.toggleMax("conv")}
          >
            <Icon name={maxed ? "minimize" : "maximize"} cls="" />
          </button>
        </div>
        <div
          className="conv-list"
          id="convList"
          ref={listRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }}
        >
          {unavailable ? (
            <div className="none" style={{ padding: 18 }}>Conversation unavailable.</div>
          ) : !loaded ? (
            <div className="none" style={{ padding: 18 }}>Loading conversation…</div>
          ) : !turns.length ? (
            <div className="none" style={{ padding: 18 }}>No messages yet — say hello to start the conversation.</div>
          ) : (
            <>
              {startIdx > 0 && (
                <button className="btn sm ghost" style={{ display: "block", margin: "0 auto 12px" }} onClick={() => setShown((n) => n + CONV_PAGE)}>
                  Load earlier · {visible.length} of {turns.length}
                </button>
              )}
              {visible.map((t, i) => (
                <Bubble key={t.seq ?? startIdx + i} t={t} snap={snap} agentId={agent.id} onZoom={setLightbox} />
              ))}
              {awaitingReply && indicator()}
            </>
          )}
        </div>
        <div className="conv-lock" id="convLock" hidden={!locked}>
          <Icon name="shield" cls="" />
          <span>{locked ? agent.alias + " is in a live terminal — conversation paused." : ""}</span>
        </div>
        <div className="conv-composer">
          {slashOpen && (
            <div className="slash" id="convSlash">
              {slashItems.map((s, i) => (
                <div
                  key={s}
                  className={"si" + (i === slashIdx % slashItems.length ? " on" : "")}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pickSlash(s);
                  }}
                >
                  {s}
                </div>
              ))}
            </div>
          )}
          <button
            type="button"
            className="conv-attach"
            id="convAttach"
            title="Attach files (or drag-drop / paste)"
            aria-label="Attach files"
            disabled={locked}
            onClick={() => fileRef.current?.click()}
            dangerouslySetInnerHTML={{ __html: CLIP_ICON }}
          />
          <input
            ref={fileRef}
            id="convAttachInput"
            type="file"
            multiple
            accept=".png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.md,.csv,.log,.json"
            style={{ display: "none" }}
            onChange={(e) => {
              uploadConvFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <textarea
            ref={taRef}
            id="convInput"
            className="conv-in"
            rows={1}
            placeholder={`Message ${agent.alias} — type / for skills…`}
            value={draft}
            disabled={locked}
            onChange={(e) => {
              setDraft(e.target.value);
              setSlashClosed(false);
              setSlashIdx(0);
            }}
            onKeyDown={onKeyDown}
            onBlur={() => setTimeout(() => setSlashClosed(true), 120)}
            onPaste={(e) => {
              const items = e.clipboardData && e.clipboardData.files;
              if (items && items.length) uploadConvFiles(items); // pasted image/file → stage (don't block text paste)
            }}
          />
          <button className="btn approve" id="convSend" disabled={locked} onClick={() => void send()}>
            <Icon name="arrow" cls="" />
            Send
          </button>
        </div>
        <div className="conv-tray" id="convTray">
          {staged.map((s) => (
            <span key={s.key} className={"att-chip" + (s.status === "uploading" ? " uploading" : s.status === "failed" ? " failed" : "")}>
              {s.status === "done" && s.ref && s.ref.kind === "image" ? (
                <img className="thumb" src={s.ref.url} alt="" />
              ) : (
                <span className="ic" dangerouslySetInnerHTML={{ __html: FILE_ICON }} />
              )}
              <span className="meta">
                <span className="nm">{s.name}</span>
                <span className="sz">{s.status === "uploading" ? "uploading…" : s.status === "failed" ? "failed" : fmtSize(s.size)}</span>
              </span>
              <button type="button" className="rm" title="Remove" onClick={() => setStaged((cur) => cur.filter((x) => x.key !== s.key))}>
                ×
              </button>
            </span>
          ))}
        </div>
        <div className="conv-note">
          Turn-based: {agent.alias} wakes, works, and replies. Live token streaming + Stop + permission cards arrive with E4.
        </div>
      </div>
      <div className="term-slot" id="convTermSlot">{pairing.termSlot}</div>
      {pairing.overlays}
      {lightbox && (
        <div className="att-lightbox" onClick={() => setLightbox(null)}>
          <img src={lightbox} alt="" />
        </div>
      )}
    </div>
  );
}
