/**
 * A run, live (like Verdikt's RecipeRunView). This is the release page: the stage card with the
 * Orb and the stage circuit; the gate card with the proof pack; what waits for you; then every step,
 * grouped by stage, each opening in place into what happened, its proof and the two or three
 * actions that apply now. Moments play only for changes this page saw.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { useActingAuthority, useSnapshot } from "../../state/SnapshotProvider";
import {
  ArrowLeft, ArrowUpRight, Check, ChevronDown, Copy, CornerDownLeft, ExternalLink, Hand, Pause, Play, RefreshCw, RotateCcw, Square, TriangleAlert, X,
} from "./icons";
import {
  clock, elapsed, flowApi, kindOf, stateOf, STATE_WORD, watchWord,
  type FlowDetail, type FlowTask, type Proof, type ProofStep, type StepState, outcomeWord,
} from "./flowApi";
import { notifierState } from "../../lib/notifier";
import { flowHref } from "./Board";
import { Circuit, Figure, KindChip, KindGlyph, Orb, StateChip, type CircuitStage, type OrbTone } from "./kit";
import { useAnnounce, useMoments, useNow } from "./motion";

const frameUrl = (id: string) => `/api/qa/frames/${encodeURIComponent(id)}`;

function stageList(d: FlowDetail) {
  const out: { key: string; title: string; tasks: FlowTask[] }[] = [];
  for (const t of d.tasks) {
    const key = t.step?.stage ?? (d.template ? "other" : t.id);
    const title = t.step?.stage_title ?? (d.template ? "Other" : t.title);
    const at = out.find((s) => s.key === key);
    if (at) at.tasks.push(t); else out.push({ key, title, tasks: [t] });
  }
  return out;
}

function stageState(tasks: FlowTask[]): StepState {
  const states = tasks.map(stateOf);
  if (states.some((s) => s === "asking")) return "asking";
  if (states.some((s) => s === "running" || s === "review")) return "running";
  if (states.some((s) => s === "ready")) return "ready";
  if (states.some((s) => s === "failed")) return "failed";
  if (states.every((s) => s === "skipped")) return "skipped";
  if (states.every((s) => s === "done" || s === "skipped")) return "done";
  return "waiting";
}

type Snap = ReturnType<typeof useSnapshot>["snap"];
const agentOf = (snap: Snap, t: FlowTask) => snap?.agents.find((a) => t.assignee_ids?.includes(a.id))?.alias;

function resultWords(t: FlowTask, who?: string): string {
  const st = stateOf(t);
  const kind = kindOf(t);
  const ran = t.history?.filter((h) => h.round) ?? [];
  if (st === "skipped" && ran.length) {
    const last = ran[ran.length - 1];
    return `Ran in round ${last.round}: ${last.outcome.replace(/_/g, " ")}${last.findings?.length ? ` · ${last.findings.length} ${last.findings.length === 1 ? "finding" : "findings"}` : ""}. Not needed after that.`;
  }
  if (st === "skipped") return t.route_state === "not_selected" ? "Not needed on this path" : "Skipped";
  if (kind === "watch" && t.watch?.needs_owner && st === "asking") return t.watch.needs_owner;
  if (kind === "watch" && t.watch?.latest?.state === "error") return `Couldn't read the status${t.watch.error ? `: ${t.watch.error}` : ""}. Trying again.`;
  if (kind === "watch" && t.watch?.latest) return `${watchWord(t.watch.latest.state)}${t.watch.latest.summary ? `: ${t.watch.latest.summary}` : ""}`;
  const o = t.reported_outcome;
  if (st === "done" || st === "failed") {
    const findings = o?.findings?.length ? ` · ${o.findings.length} ${o.findings.length === 1 ? "finding" : "findings"}` : "";
    return o ? `${o.outcome.replace(/_/g, " ")}${o.note ? `: ${o.note}` : ""}${findings}` : "Done";
  }
  if (st === "asking") return kind === "gate" ? "Your go-ahead, with the proof" : t.awaiting_loop_decision ? "Needs your decision" : "Waiting for you";
  if (st === "running") return kind === "watch" ? "Watching" : kind === "qa" ? "QA is checking" : "Working";
  if (st === "ready") return `Ready. Waiting for ${who || "its agent"} to pick it up`;
  if (st === "waiting") return t.blockers.find((b) => b.code === "gate_required")?.message ?? (t.blockers.find((b) => b.code === "prerequisites")?.message ?? "Not yet");
  return STATE_WORD[st];
}

/* ---- the gate: proof pack + Go / No-go / Send back -------------------------------------- */

function Stamp({ verdict, i }: { verdict: string; i: number }) {
  const word = verdict === "passed" ? "Pass" : verdict === "failed" ? "Fail" : verdict === "blocked" ? "Hold" : "Wait";
  return <span className="fl-stamp" data-verdict={verdict} style={{ ["--i" as string]: i }} aria-label={verdict}>{word}</span>;
}

function Film({ frames, onOpen }: { frames: { id: string; caption: string }[]; onOpen: (id: string) => void }) {
  if (!frames.length) return null;
  return (
    <div className="fl-film" aria-label="Screenshots">
      {frames.map((f, i) => (
        <button key={f.id} type="button" className="fl-frame" style={{ ["--i" as string]: i }} onClick={() => onOpen(f.id)} aria-label={`Open screenshot: ${f.caption}`} title={f.caption}>
          <img src={frameUrl(f.id)} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.visibility = "hidden"; e.currentTarget.parentElement?.setAttribute("data-missing", "true"); }} />
        </button>
      ))}
    </div>
  );
}

function platformVerdict(p: Proof["platforms"][number]): string {
  if (!p.checked) return "waiting";
  const t = p.totals;
  if (p.steps.some((s) => s.status !== "completed")) return "waiting";
  const last = p.steps.find((s) => s.scope === "full") ?? p.steps[0];
  if (last && ["fail", "fix"].includes(last.outcome ?? "")) return "failed";
  if (t.failed) return "failed";
  if (t.blocked) return "blocked";
  return "passed";
}

export function ProofPack({ proof, onFrame }: { proof: Proof; onFrame: (id: string) => void }) {
  const platforms = proof.platforms.filter((p) => p.platform !== "api" || p.checked);
  const fails = platforms.flatMap((p) => p.steps.flatMap((s) => s.failures.map((f) => ({ ...f, where: `${p.word} · ${s.title}` }))));
  const frames = platforms.flatMap((p) => p.steps.flatMap((s) => s.frames)).slice(0, 16);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div className="fl-platforms">
        {platforms.map((p, i) => {
          const v = platformVerdict(p);
          const full = p.steps.find((s) => s.scope === "full");
          return (
            <section key={p.platform} className="fl-plat" style={{ ["--i" as string]: i }} aria-label={`${p.word} proof`} data-proof-platform={p.platform}>
              <div className="fl-plat-head">
                <span><b>{p.word}</b><br /><span className="fl-muted" style={{ fontSize: 12 }}>{full ? `Full regression · round ${Math.max(1, full.rounds)}` : p.steps[0] ? `${p.steps[0].scope === "subset" ? "Changed screens" : "QA"} · round ${Math.max(1, p.steps[0].rounds)}` : "No QA step"}</span></span>
                <Stamp verdict={v} i={i} />
              </div>
              <div className="fl-figures">
                <Figure value={p.totals.passed} label="passed" tone="ok" />
                <Figure value={p.totals.failed} label="failed" tone={p.totals.failed ? "bad" : undefined} />
                <Figure value={p.totals.blocked + p.totals.skipped} label="blocked or skipped" tone={p.totals.blocked ? "warn" : undefined} />
              </div>
              {(full ?? p.steps[0])?.build ? (() => {
                const b = (full ?? p.steps[0])!.build!;
                return <span className="fl-muted" style={{ fontSize: 12 }}>Build under test: <span className="fl-mono">{[b.type, b.version && `v${b.version}`, b.build && `(${b.build})`, b.commit?.slice(0, 8), b.env].filter(Boolean).join(" · ")}</span></span>;
              })() : null}
              {p.coverage ? (
                <div className="fl-meter" data-warn={p.coverage.warn} title={`${p.coverage.validated} validated scenarios; warns below ${p.coverage.threshold}`}>
                  <span>Coverage: <b className="fl-mono" style={{ color: "var(--v2-text)" }}>{p.coverage.validated}</b> validated{p.coverage.threshold ? ` of ${p.coverage.threshold} wanted` : ""}{p.coverage.shared ? ` (${p.coverage.shared} shared)` : ""}{p.coverage.draft ? ` · ${p.coverage.draft} drafts` : ""}</span>
                  <span className="fl-meter-bar"><i style={{ ["--p" as string]: Math.min(1, p.coverage.validated / Math.max(1, p.coverage.threshold || p.coverage.validated || 1)) }} />
                    {p.coverage.threshold ? <span className="fl-meter-mark" style={{ ["--t" as string]: 1 }} /> : null}</span>
                </div>
              ) : null}
            </section>
          );
        })}
      </div>
      <Film frames={frames} onOpen={onFrame} />
      <div className="fl-cols">
        <div>
          <p className="fl-section-title">What failed or was blocked</p>
          {fails.length ? (
            <ul className="fl-fails">
              {fails.slice(0, 12).map((f, i) => (
                <li key={i} className="fl-fail">
                  {f.verdict === "blocked" ? <TriangleAlert size={14} color="var(--v2-warn)" aria-hidden="true" /> : <X size={14} color="var(--v2-danger)" aria-hidden="true" />}
                  <span><b>{f.title}</b>{f.severity ? <span className="fl-muted"> · {f.severity}</span> : null}<p>{f.where}{f.reason ? ` — ${f.reason}` : ""}</p></span>
                </li>
              ))}
            </ul>
          ) : <p className="fl-muted" style={{ fontSize: 12.5, margin: 0 }}>Nothing failed in the latest round.</p>}
          {proof.findings.items.length ? (
            <p className="fl-muted" style={{ fontSize: 12, margin: "8px 0 0" }}>
              Findings: {Object.entries(proof.findings.tally).map(([k, n]) => `${n} ${k}`).join(" · ")}
            </p>
          ) : null}
        </div>
        <div>
          <p className="fl-section-title">Checked only by unit tests</p>
          {proof.unit_only.length ? <ul className="fl-fails">{proof.unit_only.map((u) => <li key={u.task_id} className="fl-fail"><span className="fl-muted">·</span>{u.title}</li>)}</ul>
            : <p className="fl-muted" style={{ fontSize: 12.5, margin: 0 }}>Every platform in this release had a QA step.</p>}
          {proof.changed_since_last.length ? (
            <>
              <p className="fl-section-title" style={{ marginTop: 12 }}>Changed since the last pack</p>
              <ul className="fl-fails">{proof.changed_since_last.map((c, i) => <li key={i} className="fl-fail"><CornerDownLeft size={13} aria-hidden="true" />{c.title}: {c.outcome}</li>)}</ul>
            </>
          ) : null}
        </div>
      </div>
      {proof.warnings.length ? (
        <ul className="fl-warnings" aria-label="Warnings">
          {proof.warnings.map((w) => <li key={w} className="fl-problem" data-tone="warn"><TriangleAlert size={13} aria-hidden="true" />{w}</li>)}
        </ul>
      ) : null}
    </div>
  );
}

function GateCard({ d, t, actor, onDone, onFrame, after }: { d: FlowDetail; t: FlowTask; actor: string | null; onDone: (d: FlowDetail, words: string, answer: GateAnswerData) => void; onFrame: (id: string) => void; after: FlowTask[] }) {
  const [proof, setProof] = useState<Proof | null>(null);
  const [mode, setMode] = useState<"pick" | "no_go" | "send_back">("pick");
  const [reason, setReason] = useState("");
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [decided, setDecided] = useState<{ choice: string; words: string } | null>(null);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    flowApi.proof(d.id, actor, t.id, ctrl.signal).then(setProof).catch(() => {});
    return () => ctrl.abort();
  }, [d.id, d.revision, t.id, actor]);
  useEffect(() => { ref.current?.scrollIntoView?.({ behavior: "smooth", block: "start" }); }, []);
  const choices = t.step?.gate?.choices ?? ["go", "no_go", "send_back"];
  const loop = d.repeat_groups?.find((g) => g.review_task === t.id);
  const backTo = (loop?.member_tasks ?? []).filter((m) => m !== t.id).map((m) => d.tasks.find((x) => x.id === m)).filter(Boolean) as FlowTask[];
  const ships = after.filter((x) => x.step?.irreversible);
  const where = [...new Set(ships.map((x) => x.step?.outward).filter(Boolean))].join(", ");
  async function decide(choice: "go" | "no_go" | "send_back") {
    setBusy(choice);
    setError("");
    try {
      const out = await flowApi.decide(d.id, t.id, actor, { choice, reason: reason.trim() || undefined, send_back_to: choice === "send_back" ? target || backTo[0]?.id : undefined, proof_digest: proof?.digest });
      const words = choice === "go" ? `Go. ${ships.map((x) => x.title).join(", ") || "The next steps"} ${ships.length === 1 ? "runs" : "run"} now.`
        : choice === "no_go" ? "No-go. The release stops here; nothing reaches a store."
        : `Sent back to ${backTo.find((x) => x.id === (target || backTo[0]?.id))?.title ?? "the earlier step"}.`;
      setDecided({ choice, words });
      onDone(out, words, { choice, words, where, key: `${t.id}:${Date.now()}` });
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(null); }
  }
  if (decided) {
    return (
      <section className="fl-gate" data-decided={decided.choice} aria-live="polite">
        <div className="fl-gate-answer">
          <span className="fl-land-pop" style={{ background: decided.choice === "go" ? "var(--v2-ok)" : "var(--v2-band)", color: decided.choice === "go" ? "var(--v2-panel)" : "var(--v2-text-2)" }} aria-hidden="true">
            {decided.choice === "go" ? <Check size={14} strokeWidth={3} /> : decided.choice === "send_back" ? <CornerDownLeft size={14} /> : <X size={14} strokeWidth={2.75} />}
          </span>
          <b>{decided.words}</b>
        </div>
        {decided.choice === "go" && where ? <div className="fl-route" data-done="true"><span className="fl-chip" data-tone="muted">Embodent</span><span className="fl-routeline" /><span className="fl-chip" data-tone="ok">{where}</span></div> : null}
      </section>
    );
  }
  return (
    <section ref={ref} className="fl-gate" aria-labelledby={`gate-${t.id}`} data-gate={t.id}>
      <div className="fl-gate-head">
        <span className="fl-ask-node" aria-hidden="true"><Hand size={16} /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 id={`gate-${t.id}`}>{t.title}: {t.outcomes.some((o) => o.name === "send_back") ? "Go, No-go or Send back" : "Go or No-go"}</h2>
          <p>{d.dry_run ? "Dry run: the QA counts are canned; coverage is this project's real Quality data. " : ""}Nothing reaches a store or production before you say Go here.{proof ? ` Proof ${proof.digest}.` : ""}</p>
        </div>
      </div>
      {where ? <div className="fl-route" aria-label={`Go sends this to ${where}`}><span className="fl-chip" data-tone="muted">Embodent</span><span className="fl-routeline" aria-hidden="true" /><span className="fl-chip" data-tone="warn"><ArrowUpRight size={11} />{where}</span></div> : null}
      {proof ? <ProofPack proof={proof} onFrame={onFrame} /> : <p className="fl-muted">Assembling the proof…</p>}
      <div className="fl-gate-decide">
        {mode !== "pick" ? (
          <>
            {mode === "send_back" ? (
              <div className="fl-field">
                <label htmlFor={`sb-${t.id}`}>Send back to</label>
                <select id={`sb-${t.id}`} className="fl-select" value={target || backTo[0]?.id || ""} onChange={(e) => setTarget(e.target.value)}>
                  {backTo.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}
                </select>
              </div>
            ) : null}
            <div className="fl-field">
              <label htmlFor={`why-${t.id}`}>Why? (required)</label>
              <textarea id={`why-${t.id}`} className="fl-textarea" autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder={mode === "no_go" ? "What would make it a go?" : "What should change?"} />
            </div>
            <div className="fl-gate-buttons">
              <button type="button" className="fl-btn" data-variant={mode === "no_go" ? "danger" : "primary"} disabled={!reason.trim() || !!busy} onClick={() => decide(mode)} data-confirm={mode}>
                {busy ? "Saving…" : mode === "no_go" ? "Say No-go" : "Send back"}
              </button>
              <button type="button" className="fl-btn" data-variant="ghost" onClick={() => { setMode("pick"); setReason(""); }}>Cancel</button>
            </div>
          </>
        ) : (
          <div className="fl-gate-buttons">
            <button type="button" className="fl-btn" data-variant="go" data-size="lg" disabled={!!busy || !proof} onClick={() => decide("go")} data-choice="go"><Check size={16} strokeWidth={2.75} />{busy === "go" ? "Saying go…" : "Go"}</button>
            {choices.includes("no_go") ? <button type="button" className="fl-btn" data-size="lg" disabled={!!busy} onClick={() => setMode("no_go")} data-choice="no_go"><X size={16} />No-go</button> : null}
            {choices.includes("send_back") && backTo.length ? <button type="button" className="fl-btn" data-size="lg" disabled={!!busy} onClick={() => setMode("send_back")} data-choice="send_back"><CornerDownLeft size={16} />Send back…</button> : null}
          </div>
        )}
        {error ? <p className="fl-problem" role="alert">{error}</p> : null}
      </div>
    </section>
  );
}

interface GateAnswerData { choice: string; words: string; where: string; key: string }

/** The gate answers in place: the card stays a moment after the step has moved on. */
function GateAnswer({ a }: { a: GateAnswerData }) {
  return (
    <section className="fl-gate" data-decided={a.choice} aria-live="polite">
      <div className="fl-gate-answer">
        <span className="fl-land-pop" style={{ background: a.choice === "go" ? "var(--v2-ok)" : "var(--v2-band)", color: a.choice === "go" ? "var(--v2-panel)" : "var(--v2-text-2)" }} aria-hidden="true">
          {a.choice === "go" ? <Check size={14} strokeWidth={3} /> : a.choice === "send_back" ? <CornerDownLeft size={14} /> : <X size={14} strokeWidth={2.75} />}
        </span>
        <b>{a.words}</b>
      </div>
      {a.choice === "go" && a.where ? <div className="fl-route" data-done="true"><span className="fl-chip" data-tone="muted">Embodent</span><span className="fl-routeline" /><span className="fl-chip" data-tone="ok">{a.where}</span></div> : null}
    </section>
  );
}

/* ---- people's other decisions --------------------------------------------------------- */

function PersonCard({ d, t, actor, onDone }: { d: FlowDetail; t: FlowTask; actor: string | null; onDone: (d: FlowDetail, words: string) => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const loop = t.awaiting_loop_decision;
  const settle = !loop && kindOf(t) === "watch" && !!t.watch?.needs_owner;
  const stateFor = (outcome: string) => Object.entries(t.step?.watch?.state_map ?? {}).find(([, o]) => o === outcome)?.[0];
  const ranked = (names: string[]) => [...names].sort((a, b) => (a === "resubmit" ? -1 : b === "resubmit" ? 1 : 0));
  const choices = settle
    ? (t.watch?.outcomes ?? []).filter((o) => stateFor(o))
      .sort((a, b) => Number(t.outcomes.find((o) => o.name === b)?.kind === "success") - Number(t.outcomes.find((o) => o.name === a)?.kind === "success"))
      .map((o) => ({ key: o, word: outcomeWord(o) }))
    : loop
      ? ranked(t.outcomes.filter((o) => t.routes.find((r) => r.outcome === o.name)?.destination !== "ask_owner").map((o) => o.name))
        .map((name) => ({ key: name, word: kindOf(t) === "watch" ? outcomeWord(name) : name.replace(/_/g, " ") }))
      : t.outcomes.map((o) => ({ key: o.name, word: o.name.replace(/_/g, " ") }));
  const resubmits = t.outcomes.some((o) => o.name === "resubmit");
  const title = settle ? `${t.title}: only you can confirm this`
    : loop === "ask_owner"
      ? `${t.title}: ${t.reported_outcome?.outcome?.replace(/_/g, " ") ?? "needs you"}`
      : loop === "limit_reached" ? `${t.title}: the loop ran out of rounds` : loop ? `${t.title} needs a decision` : t.title;
  const why = settle ? t.watch!.needs_owner!
    : loop === "ask_owner" ? (kindOf(t) === "watch"
      ? resubmits ? "App Review said no. Fix and resubmit goes back through a fix, a new build, QA and your go-ahead before anything is sent again."
        : "The store said no. Say what happened, or stop the release."
      : "The step asked you what happens next.")
    : loop === "limit_reached" ? "Raise the limit for one more round, accept it as it is, or stop." : t.description ?? t.definition_of_done;
  async function go(key: string) {
    setBusy(key); setError("");
    try {
      let out: FlowDetail;
      if (loop) {
        if (key === "__stop") out = await flowApi.loopDecision(d, actor, { kind: "stop", task_id: t.id, note });
        else if (key === "__raise") out = await flowApi.loopDecision(d, actor, { kind: "raise_limit", task_id: t.id, new_max_rounds: (d.repeat_groups?.find((g) => g.review_task === t.id)?.max_rounds ?? 1) + 1, note });
        else if (key === "__accept") out = await flowApi.loopDecision(d, actor, { kind: "accept_override", task_id: t.id, note: note || "Accepted as it is." });
        else out = await flowApi.loopDecision(d, actor, { kind: "pick_outcome", task_id: t.id, outcome: key, note });
      } else if (settle) out = await flowApi.resolve(d.id, t.id, actor, stateFor(key)!);
      else out = await flowApi.decide(d.id, t.id, actor, { outcome: key, reason: note || undefined });
      onDone(out, `${t.title}: ${key.replace(/^__/, "").replace(/_/g, " ")}.`);
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  }
  return (
    <section className="fl-gate" data-person={t.id} aria-labelledby={`p-${t.id}`}>
      <div className="fl-gate-head">
        <span className="fl-ask-node" aria-hidden="true"><KindGlyph kind={kindOf(t)} size={16} /></span>
        <div style={{ flex: 1, minWidth: 0 }}><h2 id={`p-${t.id}`}>{title}</h2><p>{why}</p></div>
      </div>
      {kindOf(t) === "watch" && t.watch ? <WatchLine t={t} /> : null}
      {settle ? null : <textarea className="fl-textarea" placeholder="A note (optional)" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note" />}
      <div className="fl-gate-buttons">
        {choices.map((c, i) => (
          <button key={c.key} type="button" className="fl-btn" data-variant={i === 0 ? "primary" : undefined} data-size="lg" disabled={!!busy} onClick={() => go(c.key)} data-outcome={c.key}>
            {i === 0 ? <Check size={15} /> : null}{busy === c.key ? "Saving…" : c.word.charAt(0).toUpperCase() + c.word.slice(1)}
          </button>
        ))}
        {loop === "limit_reached" ? <><button type="button" className="fl-btn" data-size="lg" onClick={() => go("__raise")} disabled={!!busy}>One more round</button>
          <button type="button" className="fl-btn" data-size="lg" onClick={() => go("__accept")} disabled={!!busy}>Accept as it is</button></> : null}
        {loop ? <button type="button" className="fl-btn" data-variant="danger" data-size="lg" onClick={() => go("__stop")} disabled={!!busy}><Square size={14} />Stop here</button> : null}
      </div>
      {error ? <p className="fl-problem" role="alert">{error}</p> : null}
    </section>
  );
}

function WatchLine({ t }: { t: FlowTask }) {
  const obs = t.watch?.observations ?? [];
  const runs: { state: string; at: string | undefined }[] = [];
  for (const o of obs) if (!runs.length || runs.at(-1)!.state !== o.state) runs.push({ state: o.state, at: o.observed_at ?? o.created_at });
  if (!runs.length) return <span className="fl-muted" style={{ fontSize: 12 }}>No reading yet.</span>;
  const failing = t.watch?.latest?.state === "error";
  return (
    <div className="fl-watch" aria-label="Status readings">
      {runs.map((r, i) => (
        <Fragment key={i}>
          {i ? <span className="fl-watch-arrow" aria-hidden="true">→</span> : null}
          <span className="fl-watch-step" data-state={r.state} data-last={i === runs.length - 1}>{watchWord(r.state)}{r.at ? <span className="fl-muted fl-mono"> {clock(r.at)}</span> : null}</span>
        </Fragment>
      ))}
      {failing ? <p className="fl-problem" role="status"><TriangleAlert size={13} aria-hidden="true" />Couldn't read the status{t.watch?.error ? `: ${t.watch.error}` : ""}. This is the status command failing, not the store; it tries again.</p> : null}
    </div>
  );
}

/** What a step reported in each round, so a step skipped later still shows what it found. */
function Rounds({ t }: { t: FlowTask }) {
  const rows = t.history ?? [];
  if (rows.length < 2 && !(rows.length === 1 && stateOf(t) === "skipped")) return null;
  return (
    <div className="fl-rounds">
      <h4>Rounds</h4>
      <ol>
        {rows.map((h, i) => (
          <li key={i}>
            <span className="fl-chip" data-tone={/fail|fix|reject|changes|no_go|send_back/.test(h.outcome) ? "warn" : "ok"}>{h.round ? `Round ${h.round}` : `Report ${i + 1}`}</span>
            <b>{h.outcome.replace(/_/g, " ")}</b>
            {h.note ? <span className="fl-muted">{h.note}</span> : null}
            {h.findings?.length ? <ul>{h.findings.map((f, j) => <li key={j}>{f}</li>)}</ul> : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

/* ---- a step row, opening in place ----------------------------------------------------- */

function StepRow({ d, t, landed, take, proofStep, actor, onSaved, onFrame, open, onOpen }: {
  d: FlowDetail; t: FlowTask; landed: boolean; take: number; proofStep: ProofStep | undefined; actor: string | null;
  onSaved: (d: FlowDetail, words?: string) => void; onFrame: (id: string) => void; open: boolean; onOpen: () => void;
}) {
  const st = stateOf(t);
  const kind = kindOf(t);
  const { snap } = useSnapshot();
  const who = agentOf(snap, t);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const loop = d.repeat_groups?.find((g) => g.member_tasks.includes(t.id));
  const watchStates = Object.keys(t.step?.watch?.state_map ?? {});
  async function run(label: string, fn: () => Promise<FlowDetail>) {
    setBusy(label); setError("");
    try { onSaved(await fn()); } catch (e) { setError((e as Error).message); } finally { setBusy(""); }
  }
  return (
    <li className={`fl-scard${landed ? " fl-row-land" : ""}`} data-kind={kind} data-state={st} data-open={open} data-step={t.step?.key ?? t.id}
      onClick={(e) => { if (!open && !(e.target as HTMLElement).closest("button,a,select,textarea,input")) onOpen(); }}>
      {landed ? <span key={`wash-${take}`} className="fl-wash" /> : null}
      <span key={landed ? `land-${take}` : "rest"} className={`fl-scard-node${landed ? " fl-node-land" : ""}`} data-kind={kind}>
        {st === "done" ? <Check size={16} strokeWidth={2.75} /> : st === "failed" ? <X size={16} strokeWidth={2.75} /> : <KindGlyph kind={kind} size={16} />}
      </span>
      <span className="fl-scard-main">
        <span className="fl-scard-title"><span>{t.title}</span>{t.step?.irreversible ? <ArrowUpRight size={13} color="var(--v2-warn)" aria-label="Leaves Embodent" /> : null}</span>
        <span className="fl-scard-words">{resultWords(t, who)}</span>
      </span>
      <span className="fl-scard-side">
        {loop && (loop.current_round ?? 0) > 1 ? <span className="fl-chip" data-tone="warn">Round {loop.current_round} of {loop.max_rounds}</span> : null}
        <KindChip kind={kind} outward={t.step?.irreversible ? t.step?.outward : null} />
        <StateChip state={st} />
        <button type="button" className="fl-btn" data-variant="ghost" style={{ minHeight: 28, padding: "0 6px" }} aria-expanded={open} aria-label={`${open ? "Close" : "Open"} ${t.title}`} onClick={onOpen}>
          <ChevronDown size={14} style={{ transform: open ? "rotate(180deg)" : undefined, transition: "transform 200ms ease" }} />
        </button>
      </span>
      {st === "running" ? <span className="fl-band" aria-hidden="true" /> : null}
      {open ? (
        <div className="fl-detail">
          <div>
            <h4>What happened</h4>
            <p>{resultWords(t, who)}</p>
            {t.reported_outcome?.findings?.length ? (
              <ul className="fl-findings">{t.reported_outcome.findings.map((f) => <li key={f.id}><span className="fl-chip" data-tone={f.severity === "blocker" || f.severity === "major" ? "danger" : "muted"}>{f.severity}</span>{f.text}</li>)}</ul>
            ) : null}
            <Rounds t={t} />
            <p className="fl-muted">Done when: {t.definition_of_done}</p>
            {t.step?.build ? <p className="fl-mono fl-muted">Build: {[t.step.build.type, t.step.build.version, t.step.build.build, t.step.build.env].filter(Boolean).join(" · ")}</p> : null}
            {t.step?.secrets?.length ? <p className="fl-muted">Uses secrets by name only: {t.step.secrets.join(", ")}</p> : null}
          </div>
          <div>
            <h4>Proof</h4>
            {kind === "watch" ? <WatchLine t={t} /> : null}
            {proofStep ? (
              <>
                <div className="fl-figures">
                  <Figure value={proofStep.counts.passed} label="passed" tone="ok" />
                  <Figure value={proofStep.counts.failed} label="failed" tone={proofStep.counts.failed ? "bad" : undefined} />
                </div>
                {proofStep.scenarios.length ? (
                  <ul className="fl-fails" style={{ marginTop: 8 }}>
                    {proofStep.scenarios.slice(0, 8).map((s, i) => <li key={i} className="fl-fail"><Stamp verdict={s.verdict} i={i} /><span><b>{s.name}</b>{s.note ? <p>{s.note}</p> : null}</span></li>)}
                  </ul>
                ) : null}
                <Film frames={proofStep.frames} onOpen={onFrame} />
                {proofStep.request_id && d.container_id ? <Link className="fl-btn" data-variant="ghost" to={`/qa?${new URLSearchParams({ cid: d.container_id, request: proofStep.request_id })}`}><ExternalLink size={13} />Open the QA run</Link> : null}
              </>
            ) : kind !== "watch" ? <p className="fl-muted">{st === "done" ? "Evidence is attached to the step." : "Nothing yet."}</p> : null}
          </div>
          <div>
            <h4>Actions</h4>
            <div className="fl-detail-actions">
              {kind === "watch" && t.status === "ready" ? <>
                <button type="button" className="fl-btn" disabled={!!busy} onClick={() => run("check", async () => (await flowApi.checkNow(d.id, t.id, actor)).workflow)}><RefreshCw size={13} />{busy === "check" ? "Reading…" : "Check now"}</button>
                {watchStates.map((s) => <button key={s} type="button" className="fl-btn" data-variant="ghost" disabled={!!busy} onClick={() => run(s, () => flowApi.resolve(d.id, t.id, actor, s))}>I see it's {s.replace(/_/g, " ")}</button>)}
              </> : null}
              <Link className="fl-btn" data-variant="ghost" to={`${flowHref(`/workflows/${encodeURIComponent(d.id)}`, d.container_id, { classic: "1" })}#workflow-task-${encodeURIComponent(t.id)}`}>More…</Link>
            </div>
            {error ? <p className="fl-problem" role="alert">{error}</p> : null}
          </div>
        </div>
      ) : null}
    </li>
  );
}

/* ---- the page --------------------------------------------------------------------------- */

export function Run() {
  const { cid, bump, snap } = useSnapshot();
  const authority = useActingAuthority();
  const actor = authority.human?.id ?? null;
  const { workflowId } = useParams();
  const location = useLocation();
  const wid = workflowId ?? decodeURIComponent(location.pathname.slice("/workflows/".length));
  const navigate = useNavigate();
  const [d, setD] = useState<FlowDetail | null>(null);
  const [proof, setProof] = useState<Proof | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [busy, setBusy] = useState("");
  const [closeNote, setCloseNote] = useState("");
  const [answer, setAnswer] = useState<GateAnswerData | null>(null);
  useEffect(() => {
    if (!answer) return;
    const id = setTimeout(() => setAnswer(null), 8000);
    return () => clearTimeout(id);
  }, [answer?.key]);
  const [said, say] = useAnnounce();
  const seq = useRef(0);
  const now = useNow(1000, d?.status === "active");

  const load = useCallback(() => {
    const mine = ++seq.current;
    const ctrl = new AbortController();
    flowApi.detail(wid, actor, ctrl.signal)
      .then((x) => { if (mine === seq.current) { setD(x); setError(""); } })
      .catch((e: Error) => { if (e.name !== "AbortError" && mine === seq.current) setError(e.message); });
    return () => ctrl.abort();
  }, [wid, actor]);

  useEffect(() => load(), [load, bump]);
  useEffect(() => {
    if (!d || d.status !== "active" || !d.launch_enabled) return;
    const id = setInterval(load, 2000);
    return () => clearInterval(id);
  }, [d?.status, d?.launch_enabled, load]);
  useEffect(() => {
    if (!d) return;
    const ctrl = new AbortController();
    flowApi.proof(d.id, actor, null, ctrl.signal).then(setProof).catch(() => {});
    return () => ctrl.abort();
  }, [d?.id, d?.revision, actor]);

  const states = useMemo(() => Object.fromEntries((d?.tasks ?? []).map((t) => [t.id, stateOf(t)])), [d]);
  const over = !!d && (d.status === "completed" || d.status === "cancelled");
  const moment = useMoments(states, over);
  const stages = useMemo(() => (d ? stageList(d) : []), [d]);
  const [pulse, setPulse] = useState<{ to: number; key: number } | null>(null);
  const lastStages = useRef<string>("");
  useEffect(() => {
    const sig = stages.map((s) => stageState(s.tasks)).join(",");
    const before = lastStages.current.split(",");
    lastStages.current = sig;
    if (!before[0]) return;
    const now = sig.split(",");
    const finished = now.map((s, i) => (s === "done" && before[i] !== "done" ? i : -1)).filter((i) => i >= 0);
    if (finished.length) setPulse({ to: finished.at(-1)! + 1, key: Date.now() });
  }, [stages]);
  useEffect(() => {
    if (!d || !moment.landed.size) return;
    const names = d.tasks.filter((t) => moment.landed.has(t.id)).map((t) => `${t.title} ${stateOf(t) === "failed" ? "failed" : "is done"}`);
    if (names.length) say(names.join(". ") + ".");
  }, [moment.take]);

  const justStarted = (location.state as { justStarted?: boolean } | null)?.justStarted;
  const notice = (location.state as { notice?: string } | null)?.notice;

  if (error && !d) return <div className="fl-wrap"><p className="fl-problem" role="alert">{error}</p><Link className="fl-btn" to={flowHref("/workflows", cid)}>All workflows</Link></div>;
  if (!d) return <div className="fl-wrap"><p className="fl-muted" aria-busy="true">Loading…</p></div>;

  const live = d.tasks.filter((t) => stateOf(t) !== "skipped");
  const done = live.filter((t) => stateOf(t) === "done" || stateOf(t) === "failed").length;
  const asking = d.tasks.filter((t) => stateOf(t) === "asking");
  const gates = asking.filter((t) => kindOf(t) === "gate" && !t.awaiting_loop_decision);
  const people = asking.filter((t) => !(kindOf(t) === "gate" && !t.awaiting_loop_decision));
  const running = d.tasks.find((t) => stateOf(t) === "running");
  const ready = running ? undefined : d.tasks.find((t) => stateOf(t) === "ready");
  // A ready step only moves when an agent is woken. Say so when this project's wake service is off.
  const wakes = notifierState(snap?.container);
  const asleep = !!ready && d.status === "active" && d.launch_enabled && (wakes === "stale" || wakes === "none" || wakes === "paused");
  const settled = d.status === "active" && d.launch_enabled && d.tasks.every((t) => ["completed", "cancelled"].includes(t.status) || t.route_state === "not_selected") && !asking.length;
  const tone: OrbTone = d.status === "completed" ? (d.tasks.some((t) => stateOf(t) === "failed") ? "bad" : "good")
    : d.status === "cancelled" ? "stopped" : d.status === "paused" || !d.launch_enabled ? "held" : asking.length || settled ? "asking" : "live";
  const stageTone = tone === "live" ? undefined : tone;
  const circuit: CircuitStage[] = [
    ...stages.map((s) => {
      const st = stageState(s.tasks);
      const kinds = s.tasks.map(kindOf);
      return {
        key: s.key, title: s.title, state: st, outward: s.tasks.some((t) => t.step?.irreversible),
        count: `${s.tasks.filter((t) => ["done", "failed"].includes(stateOf(t))).length}/${s.tasks.filter((t) => stateOf(t) !== "skipped").length}`,
        kind: kinds.includes("gate") ? "gate" as const : kinds.includes("watch") ? "watch" as const : kinds.includes("qa") ? "qa" as const : kinds.includes("person") ? "person" as const : "agent" as const,
      };
    }),
    { key: "__end", title: over ? "Landed" : "Live", state: over ? "landed" as const : "waiting" as const, outward: false, count: "" },
  ];
  const outcome = d.status === "completed" ? "Finished. Every step that ran is done." : d.status === "cancelled" ? "Stopped." : !d.launch_enabled ? "A draft: nothing runs until you start it."
    : gates.length ? `${gates[0].title}: the proof is ready for your decision.` : people.length ? `${people[0].title} needs you.` : settled ? "Every step is done. Close it to record the release."
    : running ? `${running.title}: ${resultWords(running).replace(/\.+$/, "")}.`
    : ready ? `${ready.title}: ${resultWords(ready, agentOf(snap, ready)).replace(/\.+$/, "")}.` : "Waiting for the next step.";
  const afterGate = (g: FlowTask) => {
    // Everything this go-ahead releases: down the line until the next gate, which asks again.
    const out: FlowTask[] = [];
    const seen = new Set<string>([g.id]);
    let edge = [g.id];
    while (edge.length) {
      const next = d.tasks.filter((t) => !seen.has(t.id) && t.depends_on.some((x) => edge.includes(x)));
      next.forEach((t) => seen.add(t.id));
      out.push(...next.filter((t) => t.route_state !== "not_selected"));
      edge = next.filter((t) => kindOf(t) !== "gate").map((t) => t.id);
    }
    return out.filter((t) => kindOf(t) !== "gate");
  };
  const proofOf = (t: FlowTask) => proof?.platforms.flatMap((p) => p.steps).find((s) => s.task_id === t.id);
  const saved = (x: FlowDetail, words?: string) => { setD(x); if (words) say(words); };

  async function act(label: string, fn: () => Promise<FlowDetail>) {
    setBusy(label); setError("");
    try { setD(await fn()); } catch (e) { setError((e as Error).message); } finally { setBusy(""); }
  }

  return (
    <div className="fl-wrap" data-run={d.id}>
      <nav><Link className="fl-btn" data-variant="ghost" to={flowHref("/workflows", cid)}><ArrowLeft size={14} />All workflows</Link></nav>
      <section className="fl-stage" data-tone={stageTone} aria-label="The run">
        <div className="fl-stage-top">
          <Orb tone={tone} fraction={live.length ? done / live.length : 0} landedAt={moment.finished ? moment.take : 0} kind={running ? kindOf(running) : null} />
          <div className="fl-stage-main">
            <div className="fl-stage-title">
              <h1>{d.title}</h1>
              {d.dry_run ? <span className="fl-chip" data-tone="info">Dry run</span> : null}
              {d.template ? <span className="fl-chip" data-tone="muted">{d.template.name}</span> : null}
              {d.stalled ? <span className="fl-chip" data-tone="warn"><TriangleAlert size={12} />Stalled {Math.floor(d.stalled.days)} days</span> : null}
            </div>
            <p className="fl-stage-line" aria-live="polite">{outcome}</p>
            {asleep ? <p className="fl-problem" data-tone="warn" role="status"><TriangleAlert size={13} aria-hidden="true" />{wakes === "paused"
              ? "Agent wakes are off for this project, so no agent will pick up the next step. Turn them on from the button at the top right."
              : "This project's agents aren't running, so no agent will pick up the next step. Start them with orcha serve in the project folder."}</p> : null}
            {notice && !d.launch_enabled ? <p className="fl-problem" data-tone="warn" role="status"><TriangleAlert size={13} aria-hidden="true" />{notice}</p> : null}
            <p className="fl-stage-line fl-muted fl-count">{done} of {live.length} steps done · {d.created_at ? elapsed(d.created_at, now) : ""}{justStarted && d.launch_enabled && !over && done === 0 ? " · just started" : ""}</p>
          </div>
          <div className="fl-stage-actions">
            <button type="button" className="fl-btn" data-variant="ghost" onClick={() => { void navigator.clipboard?.writeText(window.location.href); say("Link copied."); }} aria-label="Copy link"><Copy size={14} /></button>
            {!d.launch_enabled && d.status === "active" ? <button type="button" className="fl-btn" data-variant="primary" disabled={!!busy} onClick={() => act("start", () => flowApi.launch(d, actor))}><Play size={14} />Start</button> : null}
            {d.status === "active" && d.launch_enabled ? <button type="button" className="fl-btn" disabled={!!busy} onClick={() => act("pause", () => flowApi.simple(d, actor, "pause"))}><Pause size={14} />Pause</button> : null}
            {d.status === "paused" ? <button type="button" className="fl-btn" data-variant="primary" disabled={!!busy} onClick={() => act("resume", () => flowApi.simple(d, actor, "resume"))}><Play size={14} />Resume</button> : null}
            {d.stalled ? <button type="button" className="fl-btn" disabled={!!busy} onClick={() => act("snooze", () => flowApi.snooze(d.id, actor, 3))}>Snooze 3 days</button> : null}
            {(d.status === "active" || d.status === "paused") ? (confirmStop
              ? <><button type="button" className="fl-btn" data-variant="danger" disabled={!!busy} onClick={() => act("stop", () => flowApi.simple(d, actor, "cancel")).then(() => setConfirmStop(false))}>Stop the run</button>
                <button type="button" className="fl-btn" data-variant="ghost" onClick={() => setConfirmStop(false)}>Keep it</button></>
              : <button type="button" className="fl-btn" data-variant="ghost" onClick={() => setConfirmStop(true)}><Square size={13} />Stop</button>) : null}
            {over && d.template ? <button type="button" className="fl-btn" onClick={() => navigate(flowHref("/workflows/new", cid, { template: d.template!.key, from: d.id }))}><RotateCcw size={14} />Run again</button> : null}
          </div>
        </div>
        <Circuit stages={circuit} pulse={pulse} asking={tone === "asking"} />
      </section>
      {error ? <p className="fl-problem" role="alert">{error}</p> : null}
      {answer && !gates.length ? <GateAnswer key={answer.key} a={answer} /> : null}
      {gates.map((g) => <GateCard key={`${g.id}:${g.work_revision}`} d={d} t={g} actor={actor} after={afterGate(g)} onFrame={setLightbox} onDone={(x, w, a) => { setAnswer(a); saved(x, w); }} />)}
      {people.map((p) => <PersonCard key={`${p.id}:${p.work_revision}:${p.awaiting_loop_decision ?? ""}`} d={d} t={p} actor={actor} onDone={saved} />)}
      {settled ? (
        <section className="fl-gate" data-decided="go" aria-label="Close the release">
          <div className="fl-gate-head"><span className="fl-ask-node" aria-hidden="true" style={{ borderColor: "var(--v2-ok)", color: "var(--v2-ok)" }}><Check size={16} /></span>
            <div><h2>Every step is done</h2><p>Close it to record the release in the history. The proof stays on this page.</p></div></div>
          <textarea className="fl-textarea" placeholder="A closing note (optional)" value={closeNote} onChange={(e) => setCloseNote(e.target.value)} aria-label="Closing note" />
          <div className="fl-gate-buttons"><button type="button" className="fl-btn" data-variant="go" data-size="lg" disabled={!!busy} onClick={() => act("close", () => flowApi.close(d.id, actor, closeNote))} data-close><Check size={15} />{busy === "close" ? "Closing…" : "Close the release"}</button></div>
        </section>
      ) : null}
      <section aria-label="Steps" className="fl-run">
        {stages.map((s, si) => {
          const st = stageState(s.tasks);
          return (
            <Fragment key={s.key}>
              {d.template ? <h3 className="fl-rail-stage" data-done={st === "done"}>{si + 1}. {s.title}</h3> : null}
              <ol className="fl-rail">
                {s.tasks.map((t) => (
                  <StepRow key={t.id} d={d} t={t} landed={moment.landed.has(t.id)} take={moment.take} proofStep={proofOf(t)} actor={actor}
                    onSaved={saved} onFrame={setLightbox} open={open === t.id} onOpen={() => setOpen((o) => (o === t.id ? null : t.id))} />
                ))}
              </ol>
            </Fragment>
          );
        })}
      </section>
      {proof && proof.decisions.length ? (
        <section aria-label="Timeline" className="fl-panel">
          <h2 className="fl-h2">Timeline</h2>
          <ol className="fl-fails">
            {proof.decisions.filter((x) => x.event !== "workflow_route_applied").slice(-14).map((x, i) => {
              const t = d.tasks.find((y) => y.id === x.task_id);
              const word = x.event === "workflow_started" ? "Started" : x.event === "workflow_completed" ? "Closed" : `${t?.title ?? "A step"}: ${String(x.detail?.outcome ?? "").replace(/_/g, " ")}`;
              return <li key={i} className="fl-fail"><span className="fl-mono fl-muted">{clock(x.at)}</span><span>{word} <span className="fl-muted">· {x.by}</span></span></li>;
            })}
          </ol>
        </section>
      ) : null}
      {lightbox ? (
        <div className="fl-lightbox" role="dialog" aria-modal="true" aria-label="Screenshot" onClick={() => setLightbox(null)} onKeyDown={(e) => { if (e.key === "Escape") setLightbox(null); }} tabIndex={-1}>
          <img src={frameUrl(lightbox)} alt="Screenshot from the QA run" />
        </div>
      ) : null}
      <p className="fl-sr" aria-live="polite">{said}</p>
    </div>
  );
}
