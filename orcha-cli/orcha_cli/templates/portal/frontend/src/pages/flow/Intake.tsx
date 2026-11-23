/**
 * The intake: log issues and feature requests by talking them through with one of the project's
 * agents. Type or dictate, drop or paste screenshots, drop a screen recording (the portal pulls its
 * key frames with ffmpeg). The agent asks until each item is clear and proposes tickets; you check
 * each card and log it into the cycle, with its screenshots, and on GitHub when you tick that.
 */
import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { Link } from "react-router-dom";
import { useSnapshot } from "../../state/SnapshotProvider";
import { notifierState } from "../../lib/notifier";
import { DictationButton } from "../../dictation/DictationButton";
import { Md } from "../../components/ui";
import { Bug, Check, ExternalLink, FileUp, Plus, RefreshCw, Sparkles, TriangleAlert, X } from "./icons";
import {
  cycleApi, intakeApi, labelName, PLATFORM_WORD, readReply, withoutBrief,
  type Compiled, type ConvAttachment, type Cycle, type Platform, type ProposedTicket, type Turn,
} from "./flowApi";
import { flowHref } from "./Board";

const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const VIDEO = /\.(mp4|mov|m4v|webm|mkv)$/i;
const MAX_PER_MESSAGE = 10;

interface Staged { key: string; name: string; kind: "image" | "video"; status: "uploading" | "done" | "failed"; refs: ConvAttachment[]; note?: string; error?: string }

const list = <T,>(v: T[] | string | null | undefined): T[] => {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") { try { const x = JSON.parse(v); return Array.isArray(x) ? x : []; } catch { return []; } }
  return [];
};

function guessIntake(people: Compiled["people"], cycle: Cycle): string | null {
  const ai = people.filter((p) => p.kind === "ai");
  return cycle.roles.intake
    ?? ai.find((a) => /intake|product|\bpm\b|triage|analyst|support/i.test(a.alias))?.id
    ?? cycle.roles.engineer ?? ai[0]?.id ?? null;
}

function Thumbs({ refs, convId }: { refs: ConvAttachment[]; convId: string }) {
  if (!refs.length) return null;
  return (
    <span className="fl-in-thumbs">
      {refs.map((a) => {
        const url = a.url ?? `/api/conversations/${encodeURIComponent(convId)}/attachments/${encodeURIComponent(a.id)}`;
        return a.kind === "image" || IMAGE.test(a.name)
          ? <a key={a.id} href={url} target="_blank" rel="noreferrer" title={a.name}><img src={url} alt={a.name} loading="lazy" /></a>
          : <a key={a.id} href={url} target="_blank" rel="noreferrer" className="fl-chip" data-tone="muted">{a.name}</a>;
      })}
    </span>
  );
}

function TicketCard({ t, cycle, convId, actor, known, onLogged }: {
  t: ProposedTicket; cycle: Cycle; convId: string; actor: string | null; known: Map<string, ConvAttachment>; onLogged: (c: Cycle) => void;
}) {
  const [title, setTitle] = useState(t.title);
  const [kind, setKind] = useState(t.kind);
  const [platforms, setPlatforms] = useState<Platform[]>(t.platforms.filter((p) => cycle.platforms.includes(p)));
  const [github, setGithub] = useState(false);
  const [labels, setLabels] = useState<string[]>(t.labels.filter((l) => !["bug", "enhancement", "feature", ...cycle.platforms].includes(l)));
  const auto = [`${cycle.kind === "hotfix" ? "hotfix" : "release"}-${cycle.version}`, kind === "feature" ? "enhancement" : "bug", ...platforms, "embodent"];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const logged = (cycle.tickets ?? []).find((x) => x.title.trim().toLowerCase() === title.trim().toLowerCase() && x.state !== "dropped");
  const refs = t.attachments.map((id) => known.get(id)).filter((a): a is ConvAttachment => !!a);
  async function log() {
    setBusy(true); setError("");
    try {
      const out = await cycleApi.addTicket(cycle.id, actor, {
        title: title.trim(), body: t.body, kind, platforms, create_issue: github, source: github ? "github" : "manual", labels,
        attachments: refs.map((a) => ({ conversation_id: convId, id: a.id, name: a.name })),
      }) as Cycle & { notice?: string | null };
      if (out.notice) setNotice(out.notice);
      onLogged(out);
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  }
  return (
    <article className="fl-in-card" data-logged={!!logged}>
      <header>
        {kind === "feature" ? <Sparkles size={15} aria-hidden="true" /> : <Bug size={15} aria-hidden="true" />}
        {logged ? <b>{logged.issue_number ? `#${logged.issue_number} ` : ""}{title}</b>
          : <input className="fl-input" aria-label="Ticket title" value={title} onChange={(e) => setTitle(e.target.value)} />}
      </header>
      <details>
        <summary>What the agent wrote</summary>
        <Md className="tx md fl-in-md fl-in-body" text={t.body || "No details."} />
      </details>
      <Thumbs refs={refs} convId={convId} />
      <div className="fl-in-labels" aria-label="GitHub labels">
        {auto.map((l) => <span key={l} className="fl-in-label" data-auto="true" title="Added for every ticket">{l}</span>)}
        {labels.map((l) => (
          <span key={l} className="fl-in-label">{l}
            {logged ? null : <button type="button" aria-label={`Remove ${l}`} onClick={() => setLabels(labels.filter((x) => x !== l))}><X size={10} /></button>}
          </span>
        ))}
        {logged ? null : <input className="fl-in-label-add" aria-label="Add a label" placeholder="+ label"
          onKeyDown={(e) => {
            const v = labelName((e.target as HTMLInputElement).value);
            if ((e.key === "Enter" || e.key === ",") && v) { e.preventDefault(); if (!labels.includes(v) && !auto.includes(v)) setLabels([...labels, v]); (e.target as HTMLInputElement).value = ""; }
          }} />}
      </div>
      {logged ? (
        <footer>
          <span className="fl-chip" data-tone="ok"><Check size={12} />Logged</span>
          {logged.workflow_id ? <Link to={flowHref(`/workflows/${encodeURIComponent(logged.workflow_id)}`, cycle.container_id)}>Its run</Link> : null}
          {logged.issue_url ? <a href={logged.issue_url} target="_blank" rel="noreferrer">On GitHub <ExternalLink size={11} /></a> : null}
          {notice ? <span className="fl-help">{notice}</span> : null}
        </footer>
      ) : (
        <footer>
          <span className="fl-toggles" role="radiogroup" aria-label="Kind">
            {(["bug", "feature"] as const).map((k) => <button key={k} type="button" role="radio" className="fl-toggle" aria-checked={kind === k} aria-pressed={kind === k} onClick={() => setKind(k)}>{k === "bug" ? "Bug" : "Feature"}</button>)}
          </span>
          <span className="fl-toggles" role="group" aria-label="Platforms">
            {cycle.platforms.map((p) => <button key={p} type="button" className="fl-toggle" aria-pressed={platforms.includes(p)}
              onClick={() => setPlatforms(platforms.includes(p) ? platforms.filter((x) => x !== p) : cycle.platforms.filter((x) => x === p || platforms.includes(x)))}>{PLATFORM_WORD[p]}</button>)}
          </span>
          <label className="fl-cy-check"><input type="checkbox" checked={github} onChange={(e) => setGithub(e.target.checked)} />Also open it on GitHub</label>
          <button type="button" className="fl-btn" data-variant="primary" disabled={busy || !title.trim() || !platforms.length} onClick={log}>
            <Plus size={14} />{busy ? "Logging…" : "Log it"}</button>
          {error ? <span className="fl-problem" role="alert"><TriangleAlert size={13} />{error}</span> : !platforms.length ? <span className="fl-help">Choose its platforms.</span> : null}
        </footer>
      )}
    </article>
  );
}

export function Intake({ cycle, actor, people, onLogged, onClose }: {
  cycle: Cycle; actor: string | null; people: Compiled["people"]; onLogged: (c: Cycle) => void; onClose: () => void;
}) {
  const { snap, bump } = useSnapshot();
  const ai = people.filter((p) => p.kind === "ai");
  const [agentId, setAgentId] = useState<string | null>(null);
  const [convId, setConvId] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [brief, setBrief] = useState<{ text: string; marker: [string, string] } | null>(null);
  const [fresh, setFresh] = useState(false);
  const [text, setText] = useState("");
  const [staged, setStaged] = useState<Staged[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [over, setOver] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => { if (!agentId && people.length) setAgentId(guessIntake(people, cycle)); }, [people.length]);
  useEffect(() => {
    intakeApi.get(cycle.id, actor).then((b) => setBrief({ text: b.brief, marker: b.marker })).catch(() => undefined);
  }, [cycle.id, cycle.tickets?.length]);
  useEffect(() => {
    if (!agentId || !actor) return;
    setConvId(null); setTurns([]); setError("");
    intakeApi.start(agentId, actor).then((r) => setConvId(r.conversation.id)).catch((e: Error) => setError(e.message));
    if (agentId !== cycle.roles.intake) cycleApi.settings(cycle.id, actor, { roles: { ...cycle.roles, intake: agentId } }).then(onLogged).catch(() => undefined);
  }, [agentId, actor]);

  const [tick, setTick] = useState(0);
  useEffect(() => { const i = window.setInterval(() => setTick((n) => n + 1), 3000); return () => window.clearInterval(i); }, []);
  useEffect(() => {
    if (!convId) return;
    const ctrl = new AbortController();
    intakeApi.turns(convId, actor, ctrl.signal).then((r) => setTurns(r.turns)).catch(() => undefined);
    return () => ctrl.abort();
  }, [convId, tick, bump]);

  // This intake session: from the last message that carried the brief.
  const marker = brief?.marker ?? ["[[intake-brief]]", "[[/intake-brief]]"] as [string, string];
  const start = fresh ? Infinity : (() => { for (let i = turns.length - 1; i >= 0; i--) if (turns[i].role === "human" && turns[i].content.includes(marker[0])) return i; return -1; })();
  const session = start === -1 || start === Infinity ? [] : turns.slice(start);
  const last = session[session.length - 1];
  const waiting = !!last && last.role === "human";
  const known = useMemo(() => {
    const m = new Map<string, ConvAttachment>();
    for (const t of session) for (const a of list<ConvAttachment>(t.attachments)) m.set(a.id, a);
    return m;
  }, [session.length, last?.id]);
  const wakes = notifierState(snap?.container);
  const asleep = wakes === "stale" || wakes === "none" || wakes === "paused";
  const agent = ai.find((a) => a.id === agentId);

  useEffect(() => { end.current?.scrollIntoView?.({ block: "nearest" }); }, [session.length]);

  function add(files: File[]) {
    if (!convId) return;
    for (const f of files) {
      const video = VIDEO.test(f.name) || f.type.startsWith("video/");
      if (!video && !(IMAGE.test(f.name) || f.type.startsWith("image/"))) { setError(`${f.name}: drop images or screen recordings.`); continue; }
      const key = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const name = f.name || (video ? "recording.mp4" : "screenshot.png");
      const named = f.name ? f : new File([f], name, { type: f.type });
      setStaged((s) => [...s, { key, name, kind: video ? "video" : "image", status: "uploading", refs: [], note: video ? "Pulling the key frames…" : undefined }]);
      (video ? intakeApi.video(convId, named, actor).then((v) => ({
        refs: [...(v.sheet ? [v.sheet] : []), ...v.frames],
        note: `${Math.round(v.video.duration)} s · ${v.frames.length} key frames${v.sheet ? " and a contact sheet" : ""}`,
      })) : intakeApi.image(convId, named, actor).then((r) => ({ refs: [r], note: undefined })))
        .then(({ refs, note }) => setStaged((s) => s.map((x) => (x.key === key ? { ...x, status: "done", refs, note } : x))))
        .catch((e: Error) => setStaged((s) => s.map((x) => (x.key === key ? { ...x, status: "failed", error: e.message } : x))));
    }
  }
  const refs = staged.filter((s) => s.status === "done").flatMap((s) => s.refs);
  const uploading = staged.some((s) => s.status === "uploading");
  const tooMany = refs.length > MAX_PER_MESSAGE;

  async function send() {
    if (!convId || !actor || sending || uploading || tooMany || (!text.trim() && !refs.length)) return;
    setSending(true); setError("");
    const words = text.trim() || "Here's what I'm seeing.";
    const content = session.length ? words : `${brief?.text ?? ""}\n\n${words}`;
    try {
      await intakeApi.say(convId, actor, content, refs, cycle.id);
      setText(""); setStaged([]); setFresh(false);
      const r = await intakeApi.turns(convId, actor);
      setTurns(r.turns);
    } catch (e) { setError((e as Error).message); }
    setSending(false);
  }
  const drop = (e: DragEvent) => { e.preventDefault(); setOver(false); add(Array.from(e.dataTransfer.files)); };

  return (
    <section className="fl-panel fl-cy-add fl-in" aria-label="Log an issue" data-over={over}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={drop}>
      <header className="fl-cy-panel-head">
        <div>
          <h2 className="fl-h2">Log an issue</h2>
          <p className="fl-help">Say it the way it comes to you. {agent ? agent.alias : "The agent"} asks until it's clear, then proposes the tickets.</p>
        </div>
        <span className="fl-head-actions">
          <label className="fl-cmp-pill">
            <span className="fl-muted">Talking with</span>
            <select aria-label="Talking with" value={agentId ?? ""} onChange={(e) => setAgentId(e.target.value || null)}>
              {ai.map((a) => <option key={a.id} value={a.id}>{a.alias}</option>)}
            </select>
          </label>
          {session.length ? <button type="button" className="fl-btn" data-variant="ghost" onClick={() => setFresh(true)} title="Start over with a fresh brief"><RefreshCw size={13} />New</button> : null}
          <button type="button" className="fl-btn" data-variant="ghost" onClick={onClose} aria-label="Close"><X size={14} /></button>
        </span>
      </header>
      {asleep ? <p className="fl-problem" data-tone="warn" role="status"><TriangleAlert size={13} />This project's agents aren't running, so {agent?.alias ?? "the agent"} won't answer yet. Start them with orcha serve in the project folder.</p> : null}

      <div className="fl-in-thread" aria-live="polite">
        {!session.length ? (
          <p className="fl-muted fl-in-empty">What did you see, or what should it do? Paste screenshots, drop a screen recording, or press the mic and talk.</p>
        ) : session.map((t) => {
          const atts = list<ConvAttachment>(t.attachments);
          if (t.role === "human") {
            return (
              <div key={t.id} className="fl-in-turn" data-role="human">
                <p>{withoutBrief(t.content, marker)}</p>
                {convId ? <Thumbs refs={atts} convId={convId} /> : null}
              </div>
            );
          }
          const { words, tickets } = readReply(t.content);
          return (
            <div key={t.id} className="fl-in-turn" data-role="agent">
              <span className="fl-in-who">{agent?.alias ?? "Agent"}</span>
              {words ? <Md className="tx md fl-in-md" text={words} /> : null}
              {convId ? <Thumbs refs={atts} convId={convId} /> : null}
              {convId ? tickets.map((tk, i) => <TicketCard key={`${t.id}-${i}`} t={tk} cycle={cycle} convId={convId} actor={actor} known={known} onLogged={onLogged} />) : null}
            </div>
          );
        })}
        {waiting ? <p className="fl-in-wait"><span className="fl-in-dots" aria-hidden="true"><i /><i /><i /></span>{agent?.alias ?? "The agent"} is reading it…</p> : null}
        <div ref={end} />
      </div>

      {staged.length ? (
        <ul className="fl-in-staged">
          {staged.map((s) => (
            <li key={s.key} data-status={s.status}>
              <span className="fl-chip" data-tone={s.status === "failed" ? "danger" : s.status === "done" ? "muted" : "info"}>{s.kind === "video" ? "Recording" : "Screenshot"}</span>
              <span className="fl-mono">{s.name}</span>
              <span className="fl-help">{s.status === "failed" ? s.error : s.status === "uploading" ? (s.note ?? "Uploading…") : s.note ?? ""}</span>
              <button type="button" className="fl-btn" data-variant="ghost" aria-label={`Remove ${s.name}`} onClick={() => setStaged((x) => x.filter((y) => y.key !== s.key))}><X size={12} /></button>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="fl-in-compose">
        <textarea ref={ta} className="fl-textarea" value={text} rows={3} aria-label="Describe it"
          placeholder={session.length ? "Answer, or add more…" : "Checkout freezes on Android when I tap Pay twice…"}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } }}
          onPaste={(e) => { const files = Array.from(e.clipboardData.files); if (files.length) { e.preventDefault(); add(files); } }} />
        <div className="fl-in-tools">
          <DictationButton getTarget={() => ta.current} />
          <button type="button" className="fl-btn" data-variant="ghost" onClick={() => file.current?.click()} disabled={!convId}><FileUp size={14} />Screenshots or a recording</button>
          <input ref={file} type="file" hidden multiple accept="image/*,video/*,.mov,.mp4,.m4v,.webm,.mkv" onChange={(e) => { add(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
          <span className="fl-help">{tooMany ? `Send at most ${MAX_PER_MESSAGE} images a message; remove some.` : uploading ? "Wait for the uploads…" : "⌘↩ to send"}</span>
          <button type="button" className="fl-btn" data-variant="primary" disabled={!convId || sending || uploading || tooMany || (!text.trim() && !refs.length)} onClick={send} data-intake-send>
            {sending ? "Sending…" : "Send"}</button>
        </div>
      </div>
      {error ? <p className="fl-problem" role="alert"><TriangleAlert size={13} />{error}</p> : null}
    </section>
  );
}
