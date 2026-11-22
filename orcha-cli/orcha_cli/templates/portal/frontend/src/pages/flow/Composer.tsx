/**
 * A blank workflow, in the same language as the template editor: the name and goal read like a
 * document title, steps sit on one vertical line, and a live check runs as you type. Underneath it
 * is exactly the classic create path: the same local draft (`workflowDraft.ts`), the same client
 * checks (`draftProblems`), the same server Preview, and the same Create with the preview digest
 * and the same idempotent operation. "Save and start" is Create followed by the one Start
 * (`/launch`). Nothing about the engine changes.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type TextareaHTMLAttributes } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useActingAuthority, useSnapshot } from "../../state/SnapshotProvider";
import { Dialog } from "../../components/primitives/Dialog";
import { Button } from "../../components/primitives/Button";
import {
  ArrowLeft, Bot, ChevronDown, ChevronUp, ClipboardPaste, CornerDownLeft, GripVertical, Layers, ListChecks, Play, Plus, RotateCw as Repeat, Target, Trash2, TriangleAlert, X,
} from "./icons";
import { flowApi, type FlowDetail } from "./flowApi";
import { flowHref } from "./Board";
import { LoopBrackets } from "./Editor";
import { useAnnounce, useDebounced, useReorder } from "./motion";
import {
  dependencyReason, discardDraft, draftProblems, draftTaskName, emptyDraft, keepDraft, newDraftTask, readDraft,
  type DraftOutcome, type DraftRepeatGroup, type DraftScope, type DraftTask, type RouteDestination, type WorkflowDraft,
} from "../workflows/workflowDraft";
import { toWireDraft } from "../workflows/WorkflowDraftSave";
import { workflowPaths, workflowRequest, workflowWriteReason } from "../workflows/workflowApi";
import type { Capability, Preview } from "../workflows/workflowContract.generated";
import { sendWorkflowOperation, useWorkflowOperation } from "../workflows/workflowOperations";
import { WorkflowOperationNotice } from "../workflows/WorkflowOperationNotice";
import { WorkflowImportImpact, type ImportChoice } from "../workflows/WorkflowImport";
import { TaskShelf } from "./TaskShelf";
import { WorkflowImportReview, importAcceptances, missingImportReview, type ImportReviews } from "../workflows/WorkflowImportReview";
import { WorkflowQaStepDialog, WorkflowTriageStepDialog } from "../workflows/WorkflowQaStep";
import { WorkflowBlockPicker } from "../workflows/WorkflowBlockPicker";
import { blocksIn, insertBlock, removeBlock } from "../workflows/workflowBlocks";
import { QUALITY_IN_WORKFLOWS, addQaStep, addTriageStep, editQaStep, editTriageStep, removeStep, stepKindWord, triageableSteps, type QaStepInput, type TriageStepInput } from "../workflows/workflowQa";
import { useLoad } from "../qa/parts";
import { listWorkflowBlocks, type QaWorkflowBlock } from "../qa/requests/api";
import { qaAgentOf } from "../qa/requests/model";

type Agent = { id: string; alias: string; role?: string | null };

/* ---- the draft is also kept on this device, for this project and this person only ---------- */
const storeKey = (s: DraftScope) => `orcha.flow.draft:${JSON.stringify([s.origin, s.project, s.identity])}`;
const isEmpty = (d: WorkflowDraft) => !d.name.trim() && !d.goal.trim() && !d.tasks.length && !d.objectives.length;
function loadDraft(scope: DraftScope): WorkflowDraft {
  const live = readDraft(scope);
  if (!isEmpty(live)) return live;
  try {
    const raw = localStorage.getItem(storeKey(scope));
    if (raw) { const d = JSON.parse(raw) as WorkflowDraft; if (d && Array.isArray(d.tasks)) return d; }
  } catch { /* storage unavailable: the page-session draft is enough */ }
  return live;
}
function storeDraft(scope: DraftScope, d: WorkflowDraft) {
  try { if (isEmpty(d)) localStorage.removeItem(storeKey(scope)); else localStorage.setItem(storeKey(scope), JSON.stringify(d)); } catch { /* ignore */ }
}
function forgetDraft(scope: DraftScope) {
  discardDraft(scope);
  try { localStorage.removeItem(storeKey(scope)); } catch { /* ignore */ }
}

/** A textarea that grows with what is typed. */
function Grow(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [props.value]);
  return <textarea ref={ref} rows={1} {...props} />;
}

/** "1. Draft the API" / "- Draft the API" / "[ ] Draft the API" → "Draft the API". */
export function planLines(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])?\s*(?:\[[ xX]?\])?\s*/, "").trim()).filter(Boolean).map((l) => l.slice(0, 200));
}

const KIND_WORD: Record<DraftOutcome["kind"], string> = { success: "Success", changes: "Needs changes", failure: "Failed", custom: "Other" };
const KIND_TONE: Record<DraftOutcome["kind"], string> = { success: "ok", changes: "warn", failure: "danger", custom: "muted" };

/** Outcomes a step can report and where each one goes. A Quality step's outcomes are fixed; only where they go changes. */
function Branches({ task, draft, ownerName, onChange }: { task: DraftTask; draft: WorkflowDraft; ownerName?: string; onChange: (outcomes: DraftOutcome[]) => void }) {
  const outcomes = task.outcomes ?? [];
  const fixed = !!task.qa;
  const tasks = draft.tasks;
  const loop = (draft.repeatGroups ?? []).find((g) => g.review === task.key);
  const dependents = tasks.filter((t) => t.dependsOn.includes(task.key));
  const choices: { value: string; label: string }[] = [
    { value: "next", label: "Carry on to the next steps" },
    ...dependents.map((t) => ({ value: `step:${t.key}`, label: `Only ${draftTaskName(t, tasks)}` })),
    ...(loop ? tasks.filter((t) => t.key !== task.key && loop.members.includes(t.key)).map((t) => ({ value: `return:${t.key}`, label: `Send back to ${draftTaskName(t, tasks)}` })) : []),
    ...(loop ? [{ value: "exit_group", label: "Leave the loop" }] : []),
    { value: "ask_owner", label: ownerName ? `Ask ${ownerName}` : "Ask the owner" },
    { value: "stop", label: "Stop here" },
  ];
  const set = (i: number, patch: Partial<DraftOutcome>) => onChange(outcomes.map((o, j) => (j === i ? { ...o, ...patch } : o)));
  return (
    <div className="fl-cmp-branches" role="group" aria-label={`What happens after ${draftTaskName(task, tasks)}`}>
      <span className="fl-label">When it finishes</span>
      {outcomes.length === 0 ? <span className="fl-help">With no outcomes, accepting its work lets the next steps start.</span> : null}
      {outcomes.map((o, i) => {
        const value = o.destinationTask ? `${o.destination}:${o.destinationTask}` : o.destination;
        return (
          <div key={i} className="fl-cmp-branch" data-tone={KIND_TONE[o.kind]}>
            <select className="fl-cmp-kind" aria-label={`Kind of outcome ${i + 1}`} value={o.kind} disabled={fixed}
              onChange={(e) => set(i, { kind: e.target.value as DraftOutcome["kind"] })}>
              {(Object.keys(KIND_WORD) as DraftOutcome["kind"][]).map((k) => <option key={k} value={k}>{KIND_WORD[k]}</option>)}
            </select>
            <input className="fl-cmp-oname" autoComplete="off" data-1p-ignore data-lpignore="true" aria-label={`Outcome ${i + 1} name`} maxLength={40} placeholder={`outcome ${i + 1}`} value={o.name} readOnly={fixed}
              onChange={(e) => set(i, { name: e.target.value })} />
            <span className="fl-cmp-arrow" aria-hidden="true">{o.destination === "return" ? <CornerDownLeft size={13} /> : "→"}</span>
            <select className="fl-select fl-cmp-dest" aria-label={`Where outcome ${i + 1} goes`} value={choices.some((c) => c.value === value) ? value : ""}
              onChange={(e) => { const [destination, key] = e.target.value.split(":"); set(i, { destination: destination as RouteDestination, destinationTask: key }); }}>
              {!choices.some((c) => c.value === value) ? <option value="">Choose where it goes…</option> : null}
              {choices.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
            {!fixed ? <button type="button" className="fl-icon-btn" aria-label={`Remove outcome ${i + 1}`} onClick={() => onChange(outcomes.filter((_, j) => j !== i))}><X size={13} /></button> : <span />}
          </div>
        );
      })}
      {!fixed && outcomes.length < 8 ? (
        <button type="button" className="fl-addbtn" style={{ alignSelf: "flex-start" }}
          onClick={() => onChange([...outcomes, { name: outcomes.length ? "changes" : "done", kind: outcomes.length ? "changes" : "success", destination: "next" }])}>
          <Plus size={13} />Add an outcome
        </button>
      ) : null}
      {!loop && outcomes.length ? <span className="fl-help">To send work back, make this step a loop's review point.</span> : null}
    </div>
  );
}

function StepCard({ task, index, draft, agents, flexible, ownerName, existing, problems, plug, onChange, onRemove, onEditQa, onRemoveBlock, grip }: {
  task: DraftTask; index: number; draft: WorkflowDraft; agents: Agent[]; flexible: boolean; ownerName?: string; existing: { id: string; title: string }[];
  problems: string[]; plug: boolean; onChange: (patch: Partial<DraftTask>) => void; onRemove: () => void; onEditQa: () => void; onRemoveBlock: (() => void) | null;
  grip: ReactNode;
}) {
  const tasks = draft.tasks;
  const [open, setOpen] = useState(!!task.description || !!task.outcomes?.length);
  const name = draftTaskName(task, tasks);
  const dependents = tasks.filter((t) => t.dependsOn.includes(task.key));
  const loop = (draft.repeatGroups ?? []).find((g) => g.members.includes(task.key));
  const reviews = (draft.repeatGroups ?? []).find((g) => g.review === task.key);
  const candidates = [
    ...tasks.filter((t) => t.key !== task.key && !task.dependsOn.includes(t.key)).map((t) => ({ id: t.key, label: `${tasks.indexOf(t) + 1}. ${draftTaskName(t, tasks)}`, reason: dependencyReason(tasks, task, t) })),
    ...existing.filter((t) => !task.dependsOn.includes(t.id)).map((t) => ({ id: t.id, label: `Existing: ${t.title}`, reason: task.dependsOn.length >= 3 ? "Remove one first" : null })),
  ];
  const titleOf = (id: string) => {
    const t = tasks.find((x) => x.key === id);
    return t ? { n: String(tasks.indexOf(t) + 1), title: draftTaskName(t, tasks) } : { n: "·", title: existing.find((e) => e.id === id)?.title ?? "An existing task" };
  };
  const kind = task.qa ? "qa" : "agent";
  return (
    <li className="fl-step fl-cmp-step" data-kind={kind} data-key={task.key} data-reorder-id={task.key} data-plug={plug} style={{ ["--i" as string]: index }}>
      <span className="fl-node fl-cmp-node" data-kind={kind}><span className="fl-mono">{index + 1}</span></span>
      <div className="fl-card fl-cmp-card" data-problem={problems.length > 0 || undefined}>
        <div className="fl-card-top">
          {grip}
          <input className="fl-cmp-title" autoComplete="off" data-1p-ignore data-lpignore="true" aria-label={`Step ${index + 1} name`} placeholder="Name this step" maxLength={200} value={task.title}
            onChange={(e) => onChange({ title: e.target.value })} data-step-title={task.key} />
          {task.qa ? <button type="button" className="fl-chip" data-tone="ok" onClick={onEditQa} title="Edit this Quality step">{stepKindWord(task.qa)}</button> : null}
          {reviews ? <span className="fl-chip" data-tone="warn"><Repeat size={11} />Reviews {reviews.name.trim() || "a loop"}</span>
            : loop ? <span className="fl-chip" data-tone="warn"><Repeat size={11} />{loop.name.trim() || "Loop"}</span> : null}
          <button type="button" className="fl-icon-btn" aria-label={`Remove ${name}`} disabled={dependents.length > 0}
            title={dependents.length ? `${dependents.map((t) => draftTaskName(t, tasks)).join(", ")} wait${dependents.length === 1 ? "s" : ""} for this step` : "Remove this step"}
            onClick={onRemove} data-remove-step={task.key}><Trash2 size={14} /></button>
        </div>
        {task.block ? (
          <span className="fl-help fl-cmp-block"><Layers size={12} />Part of {task.block.name}
            {onRemoveBlock ? <button type="button" className="fl-linkbtn" onClick={onRemoveBlock}>Remove all of it</button> : null}</span>
        ) : null}
        <Grow className="fl-cmp-done" aria-label={`Done when, step ${index + 1}`} maxLength={4000} placeholder="Done when… what proof shows it's finished?"
          value={task.doneWhen} onChange={(e) => onChange({ doneWhen: e.target.value })} />
        <div className="fl-card-foot">
          <label className="fl-cmp-pill" data-empty={!task.assignee || undefined}>
            <Bot size={12} aria-hidden="true" />
            <select aria-label={`Who does step ${index + 1}`} value={task.assignee} onChange={(e) => onChange({ assignee: e.target.value })}>
              <option value="">Choose an agent later</option>
              {agents.map((a) => <option key={a.id} value={a.id}>{a.alias}</option>)}
            </select>
          </label>
          {task.dependsOn.map((id) => {
            const t = titleOf(id);
            return (
              <span key={id} className="fl-cmp-after">
                <span className="fl-muted">after</span><b className="fl-mono">{t.n}</b><span className="fl-cmp-after-t">{t.title}</span>
                <button type="button" aria-label={`Stop waiting for ${t.title}`} onClick={() => onChange({ dependsOn: task.dependsOn.filter((k) => k !== id) })}><X size={11} /></button>
              </span>
            );
          })}
          {task.dependsOn.length < 3 && candidates.length ? (
            <label className="fl-cmp-pill" data-ghost>
              <Plus size={12} aria-hidden="true" />
              <select aria-label={`Step ${index + 1} waits for`} value="" onChange={(e) => e.target.value && onChange({ dependsOn: [...task.dependsOn, e.target.value] })}>
                <option value="">{task.dependsOn.length ? "and after…" : "Waits for…"}</option>
                {candidates.map((c) => <option key={c.id} value={c.id} disabled={!!c.reason}>{c.label}{c.reason ? " (would loop)" : ""}</option>)}
              </select>
            </label>
          ) : null}
          {!task.dependsOn.length ? <span className="fl-help">{index === 0 ? "Starts first" : draft.mode === "parallel" ? "Starts right away" : "Starts in its turn"}</span> : null}
          <button type="button" className="fl-btn fl-cmp-more" data-variant="ghost" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}{flexible ? "Instructions and outcomes" : "Instructions"}
          </button>
        </div>
        {open ? (
          <div className="fl-cmp-detail">
            <Grow className="fl-textarea" aria-label={`Instructions for step ${index + 1}`} maxLength={4000} placeholder="Anything the agent should know: links, constraints, where to look."
              value={task.description} onChange={(e) => onChange({ description: e.target.value })} />
            {flexible ? <Branches task={task} draft={draft} ownerName={ownerName} onChange={(outcomes) => onChange({ outcomes })} /> : null}
          </div>
        ) : null}
        {problems.map((p) => <span key={p} className="fl-problem" role="status"><TriangleAlert size={13} aria-hidden="true" />{p}</span>)}
      </div>
    </li>
  );
}

function LoopCard({ g, i, tasks, onChange, onRemove }: { g: DraftRepeatGroup; i: number; tasks: DraftTask[]; onChange: (patch: Partial<DraftRepeatGroup>) => void; onRemove: () => void }) {
  const review = tasks.find((t) => t.key === g.review);
  const exits = (review?.outcomes ?? []).map((o) => o.name.trim()).filter(Boolean);
  return (
    <div className="fl-cmp-loop" role="group" aria-label={`Loop ${i + 1}`}>
      <div className="fl-card-top">
        <Repeat size={14} style={{ color: "var(--v2-warn)" }} aria-hidden="true" />
        <input className="fl-cmp-title" autoComplete="off" data-1p-ignore data-lpignore="true" aria-label={`Loop ${i + 1} name`} placeholder={`Loop ${i + 1}`} maxLength={80} value={g.name} onChange={(e) => onChange({ name: e.target.value })} />
        <button type="button" className="fl-icon-btn" aria-label={`Remove loop ${i + 1}`} onClick={onRemove}><Trash2 size={13} /></button>
      </div>
      <div className="fl-toggles" role="group" aria-label="Steps that repeat">
        {tasks.map((t, n) => {
          const on = g.members.includes(t.key);
          return (
            <button key={t.key} type="button" className="fl-toggle fl-cmp-num" aria-pressed={on} title={draftTaskName(t, tasks)}
              onClick={() => onChange(on ? { members: g.members.filter((k) => k !== t.key), ...(t.key === g.review ? { review: "", exitOutcome: "" } : {}) } : { members: [...g.members, t.key] })}>
              {n + 1}
            </button>
          );
        })}
      </div>
      <label className="fl-field"><span className="fl-label">Review point</span>
        <select className="fl-select" value={g.review} disabled={!g.members.length} onChange={(e) => onChange({ review: e.target.value, exitOutcome: "" })}>
          <option value="">Choose the step that decides…</option>
          {tasks.filter((t) => g.members.includes(t.key)).map((t) => <option key={t.key} value={t.key}>{tasks.indexOf(t) + 1}. {draftTaskName(t, tasks)}</option>)}
        </select>
      </label>
      <label className="fl-field"><span className="fl-label">Leave the loop when it reports</span>
        <select className="fl-select" value={g.exitOutcome} disabled={!exits.length} onChange={(e) => onChange({ exitOutcome: e.target.value })}>
          <option value="">{review && !exits.length ? "Give the review point outcomes first" : "Choose…"}</option>
          {exits.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      </label>
      <div className="fl-cmp-rounds">
        <span className="fl-label">At most</span>
        <button type="button" className="fl-icon-btn" aria-label="One round fewer" disabled={g.maxRounds <= 1} onClick={() => onChange({ maxRounds: g.maxRounds - 1 })}>−</button>
        <b className="fl-mono" aria-live="polite">{g.maxRounds}</b>
        <button type="button" className="fl-icon-btn" aria-label="One round more" disabled={g.maxRounds >= 20} onClick={() => onChange({ maxRounds: g.maxRounds + 1 })}>+</button>
        <span className="fl-help">rounds, then you decide</span>
      </div>
    </div>
  );
}

/** Two small pictures for how work runs: one after another, or side by side. */
function ModeCard({ value, on, title, text, onPick }: { value: "serial" | "parallel"; on: boolean; title: string; text: string; onPick: () => void }) {
  return (
    <button type="button" role="radio" aria-checked={on} className="fl-cmp-mode" data-on={on} onClick={onPick}>
      <span className="fl-cmp-mode-pic" aria-hidden="true" data-mode={value}><i /><i /><i /></span>
      <span><b>{title}</b><small>{text}</small></span>
    </button>
  );
}

export function Composer() {
  const { cid, snap, identityPending } = useSnapshot();
  const authority = useActingAuthority();
  const actorId = !identityPending ? authority.human?.id ?? null : null;
  const scope = useMemo<DraftScope>(() => ({ origin: window.location.origin, project: cid ?? "", identity: actorId ?? "unverified" }), [cid, actorId]);
  return <ScopedComposer key={JSON.stringify(scope)} scope={scope} verified={!!actorId}
    agents={snap?.agents.filter((a) => a.kind === "ai" && a.status !== "terminated").map((a) => ({ id: a.id, alias: a.alias, role: a.role })) ?? []}
    ownerName={snap?.agents.find((a) => a.id === actorId)?.alias} />;
}

function ScopedComposer({ scope, verified, agents, ownerName }: { scope: DraftScope; verified: boolean; agents: Agent[]; ownerName?: string }) {
  const cid = scope.project;
  const navigate = useNavigate();
  const [draft, setDraft] = useState<WorkflowDraft>(() => loadDraft(scope));
  const [capability, setCapability] = useState<Capability | null>(null);
  const [preview, setPreview] = useState<{ basis: string; value: Preview } | null>(null);
  const [checking, setChecking] = useState(false);
  const [reviews, setReviews] = useState<ImportReviews>({});
  const [busy, setBusy] = useState<"" | "save" | "start">("");
  const [error, setError] = useState("");
  const [quick, setQuick] = useState("");
  const [pasting, setPasting] = useState(false);
  const [plan, setPlan] = useState("");
  const [plugged, setPlugged] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [existing, setExisting] = useState<ImportChoice[]>([]);
  const [qaStep, setQaStep] = useState<{ editing: string | null } | null>(null);
  const [triageStep, setTriageStep] = useState<{ editing: string | null } | null>(null);
  const [picking, setPicking] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [said, say] = useAnnounce();
  const quickRef = useRef<HTMLInputElement>(null);
  const lineRef = useRef<HTMLDivElement>(null);
  const seq = useRef(0);

  const operation = useWorkflowOperation(scope, "create");
  const frozen = operation?.state === "sending" || operation?.state === "uncertain";
  const flexible = capability?.flexible_workflows === true;
  const writeReason = workflowWriteReason(capability, verified);

  useEffect(() => {
    if (!cid || !verified) return;
    const ctrl = new AbortController();
    workflowRequest("Capability", workflowPaths.collection(cid) + "/capability", { signal: ctrl.signal, actorId: scope.identity })
      .then(setCapability).catch(() => { /* writeReason keeps saying it is checking */ });
    return () => ctrl.abort();
  }, [cid, verified, scope.identity]);

  const blocks = useLoad(flexible && QUALITY_IN_WORKFLOWS ? (s) => listWorkflowBlocks(cid, s) : null, [cid, flexible]);

  const change = (next: WorkflowDraft) => { if (frozen) return; keepDraft(scope, next); storeDraft(scope, next); setDraft(next); };
  const update = (key: string, patch: Partial<DraftTask>) => change({ ...draft, tasks: draft.tasks.map((t) => (t.key === key ? { ...t, ...patch } : t)) });
  const { snap } = useSnapshot();
  const existingTitle = (id: string) => existing.find((t) => t.id === id)?.title ?? snap?.tasks.find((t) => t.id === id)?.title ?? "An existing task";
  const lastAssignee = [...draft.tasks].reverse().find((t) => t.assignee)?.assignee ?? (agents.length === 1 ? agents[0].id : "");

  function addSteps(titles: string[], focusLast = false) {
    if (!titles.length) return;
    const room = 200 - draft.tasks.length;
    let prev = draft.tasks[draft.tasks.length - 1]?.key;
    const made = titles.slice(0, room).map((title) => {
      const t: DraftTask = { ...newDraftTask(), title, assignee: lastAssignee, dependsOn: prev ? [prev] : [] };
      prev = t.key;
      return t;
    });
    change({ ...draft, tasks: [...draft.tasks, ...made] });
    setPlugged(made[made.length - 1].key);
    say(made.length === 1 ? `${made[0].title} added as step ${draft.tasks.length + 1}.` : `${made.length} steps added.`);
    if (focusLast) requestAnimationFrame(() => quickRef.current?.focus());
  }

  // ---- client checks, then the server's Preview, debounced like the template editor's live check ----
  const problems = draftProblems(draft);
  const wire = useMemo(() => toWireDraft(draft), [draft]);
  const body = { ...wire, import_acceptances: importAcceptances(preview?.value ?? null, reviews) };
  const basis = JSON.stringify(body);
  const debounced = useDebounced(basis, 700);
  useEffect(() => {
    if (!cid || writeReason || problems.length || frozen || debounced !== basis) return;
    const mine = ++seq.current;
    const ctrl = new AbortController();
    setChecking(true);
    workflowRequest("Preview", workflowPaths.collection(cid) + "/preview", { method: "POST", body: JSON.parse(debounced), actorId: scope.identity, signal: ctrl.signal })
      .then((value) => { if (mine === seq.current) { setPreview({ basis: debounced, value }); setError(""); } })
      .catch((e: Error) => { if (e.name !== "AbortError" && mine === seq.current) setError(e.message); })
      .finally(() => { if (mine === seq.current) setChecking(false); });
    return () => ctrl.abort();
  }, [cid, debounced, writeReason, problems.length, frozen]);

  const current = preview?.basis === basis ? preview.value : null;
  const importBlocked = !!current && (current.required_task_ids.some((id) => !draft.existingTaskIds?.includes(id)) || !!current.task_impacts?.some((t) => !t.eligible) || missingImportReview(current, reviews));
  const blockers = current?.blockers ?? [];
  const taskKeys = new Set(draft.tasks.map((t) => t.key));
  const problemsOf = (key: string) => [
    ...problems.filter((p) => p.key === key).map((p) => p.message),
    ...blockers.filter((b) => b.task_id === key).map((b) => b.message),
  ];
  const loose = [
    ...problems.filter((p) => !taskKeys.has(p.key)).map((p) => p.message),
    ...blockers.filter((b) => !b.task_id || !taskKeys.has(b.task_id)).map((b) => b.message),
  ];
  const fixCount = problems.length + blockers.length;
  const saveReason = writeReason || (frozen ? "Checking the earlier save first." : !draft.tasks.length && !(draft.existingTaskIds ?? []).length ? "Add a step first."
    : fixCount ? null : importBlocked ? "Review the existing tasks you brought in." : !current ? "Checking…" : null);
  const canSave = !saveReason && !fixCount && !!current && !busy;
  const nums = (list: DraftTask[]) => `${list.length === 1 ? "step" : "steps"} ${list.map((t) => draft.tasks.indexOf(t) + 1).join(", ")}`;
  const noAgent = draft.tasks.filter((t) => !t.assignee && !t.qa);
  const noDone = draft.tasks.filter((t) => !t.doneWhen.trim());
  const startReason = noAgent.length || noDone.length
    ? `To start now, ${[noAgent.length ? `pick an agent for ${nums(noAgent)}` : "", noDone.length ? `say when ${nums(noDone)} ${noDone.length === 1 ? "is" : "are"} done` : ""].filter(Boolean).join(" and ")}. Or save it as a draft.`
    : null;

  async function save(start: boolean) {
    if (!canSave || !current) return;
    setBusy(start ? "start" : "save");
    setError("");
    try {
      const cap = await workflowRequest("Capability", workflowPaths.collection(cid) + "/capability", { actorId: scope.identity });
      if (cap.workflow_human_write !== true) { setError("Workflow changes are no longer available. Your draft is kept."); return; }
      const result = await sendWorkflowOperation(scope, "create", { operation: "create", url: workflowPaths.collection(cid), body: { ...body, preview_digest: current.preview_digest } });
      if (result.state === "refused") { setPreview(null); setError(result.message ?? "Orcha refused this draft."); return; }
      if (result.state !== "saved" || !result.result) return; // uncertain: the operation notice explains and offers a check
      forgetDraft(scope);
      const saved = result.result;
      let notice: string | undefined;
      let started = false;
      if (start) {
        try { await flowApi.launch(saved as unknown as FlowDetail, scope.identity); started = true; }
        catch (e) { notice = `Saved, but it didn't start: ${(e as Error).message}`; }
      }
      navigate(flowHref(`/workflows/${encodeURIComponent(saved.id)}`, cid), { state: { justStarted: started, notice } });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  const reorder = useReorder({
    ids: draft.tasks.map((t) => t.key),
    nameOf: (id) => { const t = draft.tasks.find((x) => x.key === id); return t ? draftTaskName(t, draft.tasks) : "step"; },
    onMove: (from, to) => { const tasks = [...draft.tasks]; const [m] = tasks.splice(from, 1); tasks.splice(to, 0, m); change({ ...draft, tasks }); },
  });

  const saveQa = (input: QaStepInput) => { const n = qaStep?.editing ? editQaStep(draft, qaStep.editing, input) : addQaStep(draft, input); change(n.draft); setPlugged(n.key); setQaStep(null); };
  const saveTriage = (input: TriageStepInput) => { const n = triageStep?.editing ? editTriageStep(draft, triageStep.editing, input) : addTriageStep(draft, input); change(n.draft); setPlugged(n.key); setTriageStep(null); };
  const addBlock = (block: QaWorkflowBlock, after: string | null) => {
    const quality = qaAgentOf(agents, null);
    const others = agents.filter((a) => a.id !== quality?.id);
    change(insertBlock(draft, block, { after, assignees: { quality: quality?.id, build: others.length === 1 ? others[0].id : undefined } }).draft);
    setPicking(false);
  };
  const blockSizes = new Map(blocksIn(draft).map((b) => [b.id, b.steps]));

  if (!cid) return <div className="fl-wrap"><p className="fl-muted">Choose a project first.</p></div>;

  const loops = (draft.repeatGroups ?? []).filter((g) => g.members.length).map((g, i) => ({ name: g.name.trim() || `Loop ${i + 1}`, members: g.members, review: g.review, max_rounds: g.maxRounds }));
  const quickKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter" || !quick.trim()) return;
    e.preventDefault();
    const lines = planLines(quick);
    addSteps(lines.length ? lines : [quick.trim()], true);
    setQuick("");
  };

  return (
    <div className="fl-wrap fl-cmp">
      <nav className="fl-head">
        <Link className="fl-btn" data-variant="ghost" to={flowHref("/workflows/new", cid)}><ArrowLeft size={14} />Templates</Link>
        <div className="fl-head-actions">
          <span className="fl-help">{isEmpty(draft) ? "A draft. Nothing runs until you start it." : "Draft kept on this device. Nothing runs until you start it."}</span>
          {!isEmpty(draft) ? <button type="button" className="fl-btn" data-variant="ghost" onClick={() => setConfirmDiscard(true)} disabled={frozen}>Discard</button> : null}
        </div>
      </nav>

      <header className="fl-cmp-head">
        <input className="fl-cmp-name" autoComplete="off" data-1p-ignore data-lpignore="true" aria-label="Workflow name" placeholder="Untitled workflow" maxLength={200} value={draft.name} autoFocus={!draft.name}
          onChange={(e) => change({ ...draft, name: e.target.value })} aria-invalid={problems.some((p) => p.key === "name") && !!draft.tasks.length || undefined} />
        <Grow className="fl-cmp-goal" aria-label="Goal" placeholder="What should be true when this is done?" maxLength={4000} value={draft.goal}
          onChange={(e) => change({ ...draft, goal: e.target.value })} />
        <div className="fl-cmp-meta">
          <span className="fl-chip" data-tone="muted"><span className="fl-cmp-avatar" aria-hidden="true">{(ownerName ?? "Y").slice(0, 1).toUpperCase()}</span>{ownerName ? `Owned by ${ownerName}` : "Owned by you"}</span>
          <span className="fl-chip" data-tone="muted">{draft.tasks.length} {draft.tasks.length === 1 ? "step" : "steps"}</span>
          {(draft.repeatGroups ?? []).length ? <span className="fl-chip" data-tone="warn"><Repeat size={11} />{draft.repeatGroups!.length} {draft.repeatGroups!.length === 1 ? "loop" : "loops"}</span> : null}
          {draft.objectives.length ? <span className="fl-chip" data-tone="accent"><Target size={11} />{draft.objectives.length} {draft.objectives.length === 1 ? "objective" : "objectives"}</span> : null}
        </div>
      </header>

      <div className="fl-editor">
        <aside className="fl-panel fl-params" aria-label="How it runs">
          <div className="fl-field" role="radiogroup" aria-label="How work runs">
            <span className="fl-label">How work runs</span>
            <ModeCard value="serial" on={draft.mode === "serial"} title="One at a time" text="Each step takes its turn, in order." onPick={() => change({ ...draft, mode: "serial" })} />
            <ModeCard value="parallel" on={draft.mode === "parallel"} title="Side by side" text="Steps that don't wait on each other run together." onPick={() => change({ ...draft, mode: "parallel" })} />
          </div>

          <div className="fl-field">
            <span className="fl-label"><Target size={12} /> Done means <span className="fl-muted">· optional</span></span>
            {draft.objectives.map((o, i) => (
              <div key={o.key} className="fl-cmp-obj">
                <div className="fl-card-top">
                  <input className="fl-cmp-title" autoComplete="off" data-1p-ignore data-lpignore="true" aria-label={`Objective ${i + 1}`} placeholder={`Objective ${i + 1}`} maxLength={200} value={o.title}
                    onChange={(e) => change({ ...draft, objectives: draft.objectives.map((x) => (x.key === o.key ? { ...x, title: e.target.value } : x)) })} />
                  <button type="button" className="fl-icon-btn" aria-label={`Remove objective ${i + 1}`} onClick={() => change({ ...draft, objectives: draft.objectives.filter((x) => x.key !== o.key) })}><X size={13} /></button>
                </div>
                <Grow className="fl-cmp-done" aria-label={`Objective ${i + 1} is met when`} placeholder="It's met when…" maxLength={4000} value={o.criteria}
                  onChange={(e) => change({ ...draft, objectives: draft.objectives.map((x) => (x.key === o.key ? { ...x, criteria: e.target.value } : x)) })} />
                {problems.filter((p) => p.key === o.key).slice(0, 1).map((p) => <span key={p.message} className="fl-problem"><TriangleAlert size={12} />{p.message}</span>)}
              </div>
            ))}
            <button type="button" className="fl-addbtn" style={{ alignSelf: "flex-start" }} disabled={draft.objectives.length >= 50}
              onClick={() => change({ ...draft, objectives: [...draft.objectives, { key: crypto.randomUUID(), title: "", criteria: "" }] })}><Plus size={13} />Add an objective</button>
          </div>

          {flexible ? (
            <div className="fl-field">
              <span className="fl-label"><Repeat size={12} /> Loops <span className="fl-muted">· repeat until a review passes</span></span>
              {(draft.repeatGroups ?? []).map((g, i) => (
                <div key={g.key}>
                  <LoopCard g={g} i={i} tasks={draft.tasks}
                    onChange={(patch) => change({ ...draft, repeatGroups: (draft.repeatGroups ?? []).map((x) => (x.key === g.key ? { ...x, ...patch } : x)) })}
                    onRemove={() => change({ ...draft, repeatGroups: (draft.repeatGroups ?? []).filter((x) => x.key !== g.key) })} />
                  {problems.filter((p) => p.key === g.key).slice(0, 1).map((p) => <span key={p.message} className="fl-problem"><TriangleAlert size={12} />{p.message}</span>)}
                </div>
              ))}
              <button type="button" className="fl-addbtn" style={{ alignSelf: "flex-start" }} disabled={(draft.repeatGroups ?? []).length >= 5 || draft.tasks.length < 2}
                title={draft.tasks.length < 2 ? "A loop needs at least two steps." : undefined}
                onClick={() => change({ ...draft, repeatGroups: [...(draft.repeatGroups ?? []), { key: crypto.randomUUID(), name: "", members: [], review: "", exitOutcome: "", maxRounds: 3 }] })}>
                <Plus size={13} />Add a loop
              </button>
            </div>
          ) : null}

          <div className="fl-field">
            <span className="fl-label"><ListChecks size={12} /> Tasks you already have</span>
            {(draft.existingTaskIds ?? []).length ? (
              <ul className="fl-cmp-existing">
                {draft.existingTaskIds!.map((id) => (
                  <li key={id} className="fl-cmp-after">
                    <span className="fl-cmp-after-t">{existingTitle(id)}</span>
                    <button type="button" aria-label={`Leave out ${existingTitle(id)}`} onClick={() => change({ ...draft, existingTaskIds: draft.existingTaskIds!.filter((x) => x !== id) })}><X size={11} /></button>
                  </li>
                ))}
              </ul>
            ) : null}
            <button type="button" className="fl-addbtn" style={{ alignSelf: "flex-start" }} onClick={() => setImportOpen(true)}>
              <Plus size={13} />{(draft.existingTaskIds ?? []).length ? "Change" : "Bring in existing tasks"}
            </button>
          </div>
        </aside>

        <section aria-label="Steps">
          <div className="fl-line fl-cmp-line" ref={lineRef}>
            {draft.tasks.length ? <span className="fl-line-rule" aria-hidden="true" /> : null}
            {loops.length ? <LoopBrackets loops={loops} host={lineRef} sig={`${draft.tasks.map((t) => t.key).join()}|${loops.map((l) => l.members.join() + l.name).join(";")}`} /> : null}
            {draft.tasks.length ? (
              <ol className="fl-steps" ref={reorder.listRef}>
                {draft.tasks.map((task, i) => (
                  <StepCard key={task.key} task={task} index={i} draft={draft} agents={agents} flexible={flexible} ownerName={ownerName}
                    existing={(draft.existingTaskIds ?? []).map((id) => ({ id, title: existingTitle(id) }))}
                    problems={problemsOf(task.key)} plug={plugged === task.key} onChange={(patch) => update(task.key, patch)}
                    onRemove={() => { change(removeStep(draft, task.key)); say(`${draftTaskName(task, draft.tasks)} removed.`); }}
                    onEditQa={() => (task.qa?.kind === "triage" ? setTriageStep({ editing: task.key }) : setQaStep({ editing: task.key }))}
                    onRemoveBlock={task.block && (blockSizes.get(task.block.id) ?? 0) > 1 ? () => change(removeBlock(draft, task.block!.id)) : null}
                    grip={draft.tasks.length > 1 ? (
                      <button type="button" className="fl-grip" aria-label={`Move ${draftTaskName(task, draft.tasks)}. Use the arrow keys.`} data-dragging={reorder.dragging === task.key || undefined}
                        onPointerDown={(e) => reorder.start(i, e)} onKeyDown={(e) => reorder.keyDown(i, e)}><GripVertical size={14} /></button>
                    ) : null} />
                ))}
              </ol>
            ) : (
              <div className="fl-cmp-empty">
                <span className="fl-cmp-empty-node" aria-hidden="true"><Plus size={18} /></span>
                <div>
                  <p className="fl-h2">What's the first step?</p>
                  <p className="fl-sub">Type it below and press Enter. Each new step waits for the one before it; you can change that on its card.</p>
                </div>
              </div>
            )}
            <div className="fl-cmp-quick" data-first={!draft.tasks.length || undefined}>
              <span className="fl-cmp-quick-node" aria-hidden="true"><Plus size={14} /></span>
              <input ref={quickRef} className="fl-cmp-quick-input" autoComplete="off" data-1p-ignore data-lpignore="true" aria-label="Add a step" placeholder={draft.tasks.length ? "Add a step and press Enter" : "e.g. Draft the API changes"}
                value={quick} maxLength={4000} disabled={frozen || draft.tasks.length >= 200} onChange={(e) => setQuick(e.target.value)} onKeyDown={quickKey}
                onPaste={(e) => {
                  const text = e.clipboardData.getData("text");
                  if (planLines(text).length > 1) { e.preventDefault(); setPlan(text); setPasting(true); }
                }} />
              <kbd className="fl-cmp-kbd" aria-hidden="true">↵</kbd>
            </div>
            <div className="fl-cmp-actions">
              <button type="button" className="fl-addbtn" onClick={() => setPasting((p) => !p)} aria-expanded={pasting}><ClipboardPaste size={13} />Paste a plan</button>
              {QUALITY_IN_WORKFLOWS ? <button type="button" className="fl-addbtn" onClick={() => setQaStep({ editing: null })}><Plus size={13} />Quality step</button> : null}
              {QUALITY_IN_WORKFLOWS && triageableSteps(draft).length ? <button type="button" className="fl-addbtn" onClick={() => setTriageStep({ editing: null })}><Plus size={13} />Triage step</button> : null}
              {QUALITY_IN_WORKFLOWS && blocks.data?.length ? <button type="button" className="fl-addbtn" onClick={() => setPicking(true)}><Layers size={13} />Quality workflow</button> : null}
            </div>
            {pasting ? (
              <div className="fl-cmp-paste">
                <Grow className="fl-textarea" autoFocus aria-label="Your plan, one step per line" placeholder={"One step per line:\n1. Draft the API changes\n2. Update the mobile client\n3. Review and merge"}
                  value={plan} onChange={(e) => setPlan(e.target.value)} />
                <div className="fl-head-actions">
                  <span className="fl-help">{planLines(plan).length} {planLines(plan).length === 1 ? "step" : "steps"}, in order</span>
                  <button type="button" className="fl-btn" data-variant="ghost" onClick={() => { setPasting(false); setPlan(""); }}>Cancel</button>
                  <button type="button" className="fl-btn" data-variant="primary" disabled={!planLines(plan).length}
                    onClick={() => { addSteps(planLines(plan)); setPlan(""); setPasting(false); }}>Add {planLines(plan).length || ""} steps</button>
                </div>
              </div>
            ) : null}
          </div>
        </section>
      </div>

      {current && (draft.existingTaskIds?.length ?? 0) > 0 ? (
        <section className="fl-panel fl-cmp-import wf-page" aria-labelledby="fl-cmp-import-h">
          <h2 id="fl-cmp-import-h" className="fl-h2">Tasks you're bringing in</h2>
          <WorkflowImportImpact preview={current} selected={draft.existingTaskIds ?? []} onChange={(ids) => change({ ...draft, existingTaskIds: ids })} cid={cid} />
          <WorkflowImportReview preview={current} reviews={reviews} onChange={setReviews} disabled={!!busy || frozen} />
        </section>
      ) : null}

      <WorkflowOperationNotice scope={scope} slot="create" canRetry={async () => !writeReason}
        onSaved={(result) => { forgetDraft(scope); navigate(flowHref(`/workflows/${encodeURIComponent(result.id)}`, cid)); }} />

      <div className="fl-startbar" role="region" aria-label="Save">
        <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
          <span className="fl-check" data-ok={isEmpty(draft) ? undefined : fixCount || saveReason ? (fixCount ? "false" : undefined) : "true"} aria-live="polite">
            {isEmpty(draft) ? <>Name it, say what done looks like, and add the first step.</>
              : checking ? <><span className="fl-spin" aria-hidden="true" />Checking with Orcha…</>
              : fixCount ? <><TriangleAlert size={14} aria-hidden="true" />{fixCount} to fix before saving</>
              : saveReason ? <>{saveReason}</> : <>Checked. Ready to save.</>}
          </span>
          {!checking && !isEmpty(draft) ? loose.slice(0, 2).map((m, i) => <span key={i} className="fl-problem" data-tone="warn">{m}</span>) : null}
          {canSave && startReason ? <span className="fl-help">{startReason}</span> : null}
          {error ? <span className="fl-problem" role="alert">{error}</span> : null}
        </div>
        <div className="fl-head-actions">
          <button type="button" className="fl-btn" data-size="lg" disabled={!canSave} onClick={() => save(false)} data-save-draft>
            {busy === "save" ? "Saving…" : "Save as draft"}
          </button>
          <button type="button" className="fl-btn" data-variant="primary" data-size="lg" disabled={!canSave || !!startReason} onClick={() => save(true)} data-save-start
            title={startReason ?? undefined}>
            <Play size={15} />{busy === "start" ? "Starting…" : "Save and start"}
          </button>
        </div>
      </div>
      <p className="fl-sr" aria-live="polite">{said}{reorder.said}</p>

      {importOpen ? (
        <TaskShelf selected={draft.existingTaskIds ?? []} onChange={(ids) => change({ ...draft, existingTaskIds: ids })} onSelectedChoices={setExisting} onClose={() => setImportOpen(false)} />
      ) : null}
      {confirmDiscard ? (
        <Dialog title="Discard this draft?" description="Its name, goal and steps are removed from this device. No saved workflow changes." onClose={() => setConfirmDiscard(false)}
          footer={<><Button onClick={() => setConfirmDiscard(false)}>Keep editing</Button><Button variant="danger" onClick={() => { forgetDraft(scope); setDraft(emptyDraft()); setPreview(null); setConfirmDiscard(false); }}>Discard draft</Button></>} />
      ) : null}
      {qaStep ? <WorkflowQaStepDialog cid={cid} draft={draft} agents={agents} flexible={flexible} ownerName={ownerName} editing={qaStep.editing} onSave={saveQa} onClose={() => setQaStep(null)} /> : null}
      {triageStep ? <WorkflowTriageStepDialog cid={cid} draft={draft} agents={agents} flexible={flexible} ownerName={ownerName} editing={triageStep.editing} onSave={saveTriage} onClose={() => setTriageStep(null)} /> : null}
      {picking ? <WorkflowBlockPicker cid={cid} blocks={blocks.data ?? []} draft={draft} initialAfter={draft.tasks[draft.tasks.length - 1]?.key ?? null} onPick={addBlock} onClose={() => setPicking(false)} /> : null}
    </div>
  );
}
