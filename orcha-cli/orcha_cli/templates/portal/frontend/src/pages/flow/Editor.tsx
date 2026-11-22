/**
 * New from a template (like Verdikt's RecipeEditor): parameters in one card, then one vertical line,
 * top to bottom: stages are waypoints, each step a node and a card with its kind, who does it and
 * when it is done. Remove a step with its switch (required steps show a lock and why); add one
 * with the picker; loops are brackets beside the line; branches are small side arrows. A debounced
 * live check shows every problem inline under its card, never in a dialog, and Start stays off
 * until the check is clean. Starting is one button.
 */
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useActingAuthority, useSnapshot } from "../../state/SnapshotProvider";
import { ArrowLeft, ArrowUpRight, ChevronDown, ChevronUp, CornerDownLeft, Download, Play, Plus, Archive as Save, TriangleAlert, X } from "./icons";
import { flowApi, FlowError, KIND_WORD, PLATFORM_WORD, type AddedStep, type Compiled, type CompiledStep, type Platform, type StepKind, type TemplateParam, type TemplateSummary } from "./flowApi";
import { flowHref } from "./Board";
import { Gallery } from "./Gallery";
import { KindChip, KindGlyph, Lockline } from "./kit";
import { useAnnounce, useDebounced } from "./motion";

const PLATFORMS: Platform[] = ["ios", "android", "web", "api"];

function ParamField({ p, value, onChange, invalid }: { p: TemplateParam; value: unknown; onChange: (v: unknown) => void; invalid: boolean }) {
  const id = `fl-param-${p.key}`;
  if (p.type === "platforms") {
    const chosen = new Set((value as string[]) ?? []);
    return (
      <div className="fl-field" role="group" aria-labelledby={`${id}-l`}>
        <span id={`${id}-l`} className="fl-label">{p.label}</span>
        <div className="fl-toggles">
          {PLATFORMS.map((x) => (
            <button key={x} type="button" className="fl-toggle" aria-pressed={chosen.has(x)} data-platform={x}
              onClick={() => { const n = new Set(chosen); n.has(x) ? n.delete(x) : n.add(x); onChange(PLATFORMS.filter((y) => n.has(y))); }}>
              {PLATFORM_WORD[x]}
            </button>
          ))}
        </div>
        {invalid ? <span className="fl-problem">Pick at least one platform.</span> : null}
      </div>
    );
  }
  if (p.type === "choice") {
    return (
      <div className="fl-field" role="radiogroup" aria-labelledby={`${id}-l`}>
        <span id={`${id}-l`} className="fl-label">{p.label}{p.required ? " *" : ""}</span>
        <div className="fl-toggles">
          {(p.choices ?? []).map((c) => (
            <button key={c.value} type="button" role="radio" className="fl-toggle" aria-checked={value === c.value} aria-pressed={value === c.value}
              onClick={() => onChange(c.value)} data-choice={`${p.key}:${c.value}`}>{c.label}</button>
          ))}
        </div>
        {p.help ? <span className="fl-help">{p.help}</span> : null}
        {invalid ? <span className="fl-problem">Choose one.</span> : null}
      </div>
    );
  }
  const common = { id, "aria-invalid": invalid || undefined, placeholder: p.placeholder ?? "", className: p.type === "longtext" ? "fl-textarea" : "fl-input" };
  return (
    <div className="fl-field">
      <label htmlFor={id}>{p.label}{p.required ? " *" : ""}</label>
      {p.type === "longtext"
        ? <textarea {...common} value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} />
        : <input {...common} type={p.type === "number" ? "number" : "text"} value={String(value ?? "")} onChange={(e) => onChange(p.type === "number" ? Number(e.target.value) : e.target.value)} />}
      {p.help ? <span className="fl-help">{p.help}</span> : null}
      {invalid ? <span className="fl-problem">Fill this in.</span> : null}
    </div>
  );
}

const PICKS: { group: string; kind: StepKind; title: string; hint: string; outcomes?: AddedStep["outcomes"] }[] = [
  { group: "Build", kind: "agent", title: "Agent step", hint: "An agent does a piece of work and posts its proof." },
  { group: "QA", kind: "qa", title: "QA check", hint: "Quality checks scenarios on a device or the web." },
  { group: "Ship", kind: "agent", title: "Deploy and prove it's live", hint: "A deploy that checks the live system, not just the exit code." },
  { group: "Watch", kind: "watch", title: "Watch a status", hint: "Waits on an outside status: a store review, a build." },
  { group: "People", kind: "person", title: "Person step", hint: "Someone does it or decides, and says so here.", outcomes: [{ name: "done", kind: "success" }] },
  { group: "People", kind: "gate", title: "Go / no-go gate", hint: "You see the proof and say Go, No-go or Send back.", outcomes: [{ name: "go", kind: "success" }, { name: "no_go", kind: "failure" }] },
];

function Picker({ onPick, onClose }: { onPick: (p: (typeof PICKS)[number], title: string) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [title, setTitle] = useState("");
  const list = PICKS.filter((p) => !q || `${p.title} ${p.hint} ${p.group}`.toLowerCase().includes(q.toLowerCase()));
  const groups = [...new Set(list.map((p) => p.group))];
  return (
    <div className="fl-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="fl-dialog fl" role="dialog" aria-modal="true" aria-labelledby="fl-pick-title" onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}>
        <div className="fl-head"><h2 id="fl-pick-title" className="fl-h2">Add a step</h2><button type="button" className="fl-btn" data-variant="ghost" onClick={onClose} aria-label="Close"><X size={15} /></button></div>
        <input className="fl-input" autoFocus placeholder="Search: deploy, review, QA…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search steps" />
        <input className="fl-input" placeholder="Name it (optional)" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Step name" />
        <div className="fl-picker">
          {groups.map((g) => (
            <div key={g}>
              <p className="fl-section-title">{g}</p>
              <div className="fl-picker-grid">
                {list.filter((p) => p.group === g).map((p) => (
                  <button key={p.title} type="button" className="fl-pick" data-kind={p.kind} onClick={() => onPick(p, title.trim() || p.title)}>
                    <span style={{ display: "flex", gap: 6, alignItems: "center", color: "var(--tone)" }}><KindGlyph kind={p.kind} size={15} /><b style={{ color: "var(--v2-text)" }}>{p.title}</b></span>
                    <small>{p.hint}</small>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function StepCard({ s, i, problems, onToggle, onAddAfter, plug, assignee, names }: {
  s: CompiledStep; i: number; problems: string[]; onToggle: () => void; onAddAfter: () => void; plug: boolean; assignee: string; names: Record<string, string>;
}) {
  const [open, setOpen] = useState(false);
  const removable = !s.required && s.removed_why !== "platform" && s.removed_why !== "condition";
  return (
    <li className="fl-step" data-kind={s.kind} data-removed={s.removed} data-plug={plug} data-key={s.client_key} style={{ ["--i" as string]: i }}>
      <span className="fl-node" data-kind={s.kind} data-out={s.irreversible}><KindGlyph kind={s.kind} size={17} /></span>
      <div className="fl-card" data-out={s.irreversible}>
        <div className="fl-card-top">
          <span className="fl-card-title" title={s.title}>{s.title}</span>
          <KindChip kind={s.kind} outward={s.irreversible ? s.outward : null} />
          {s.required ? <Lockline>Required</Lockline> : s.removed_why === "platform" || s.removed_why === "condition" ? <span className="fl-muted" style={{ fontSize: 11.5 }}>{s.removed_why === "condition" ? "Not for this release type" : "Not for these platforms"}</span> : (
            <button type="button" role="switch" className="fl-switch" aria-checked={!s.removed} aria-label={`${s.removed ? "Add back" : "Remove"} ${s.title}`} onClick={onToggle} data-remove={s.client_key} disabled={!removable} />
          )}
        </div>
        {!s.removed ? (
          <>
            <div className="fl-card-done"><b>Done when</b>{s.done_when}</div>
            <div className="fl-card-foot">
              <span className="fl-chip" data-tone="muted">{assignee}</span>
              {s.platforms.map((p) => <span key={p} className="fl-chip" data-tone="muted">{PLATFORM_WORD[p]}</span>)}
              {s.branches.map((b) => (
                <span key={b.outcome} className="fl-branch" data-dest={b.destination}>
                  {b.destination === "return" ? <CornerDownLeft size={11} /> : <ArrowUpRight size={11} />}
                  {b.outcome.replace(/_/g, " ")} → {b.destination === "return" ? `back to ${names[b.to ?? ""] ?? "an earlier step"}` : b.destination === "stop" ? "stop" : b.destination === "ask_owner" ? "you decide" : b.destination === "exit_group" ? "leave the loop" : names[b.to ?? ""] ?? "next"}
                </span>
              ))}
              <button type="button" className="fl-btn" data-variant="ghost" style={{ minHeight: 24, padding: "0 6px", marginLeft: "auto" }} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
                {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}<span className="fl-sr">Details of {s.title}</span>
              </button>
            </div>
            {open ? <p className="fl-card-done" style={{ animation: "land-rise 260ms var(--fl-rise) both" }}>{s.description}</p> : null}
            {problems.map((p) => <span key={p} className="fl-problem" role="status"><TriangleAlert size={13} aria-hidden="true" />{p}</span>)}
          </>
        ) : s.locked_reason ? <Lockline>{s.locked_reason}</Lockline> : null}
      </div>
      {!s.removed ? <button type="button" className="fl-plus" onClick={onAddAfter} aria-label={`Add a step after ${s.title}`} title="Add a step here"><Plus size={12} strokeWidth={2.6} /></button> : null}
    </li>
  );
}

/** Brackets beside the line for each loop, measured from the cards it spans. */
export function LoopBrackets({ loops, host, sig }: { loops: Compiled["loops"]; host: React.RefObject<HTMLDivElement>; sig: string }) {
  const [boxes, setBoxes] = useState<{ name: string; top: number; height: number; rounds: number }[]>([]);
  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const measure = () => {
      const base = el.getBoundingClientRect().top;
      setBoxes(loops.map((l) => {
        const rects = l.members.map((m) => el.querySelector<HTMLElement>(`[data-key="${CSS.escape(m)}"]`)?.getBoundingClientRect()).filter(Boolean) as DOMRect[];
        if (!rects.length) return null;
        const top = Math.min(...rects.map((r) => r.top)) - base;
        const bottom = Math.max(...rects.map((r) => r.bottom)) - base;
        return { name: l.name, top, height: bottom - top, rounds: l.max_rounds };
      }).filter(Boolean) as { name: string; top: number; height: number; rounds: number }[]);
    };
    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [sig]);
  return <>{boxes.map((b) => (
    <span key={b.name} className="fl-loop" style={{ top: b.top + 8, height: b.height - 16 }} aria-hidden="true">
      <span className="fl-loop-label">{b.name} · up to {b.rounds} rounds</span>
    </span>
  ))}</>;
}

export function Editor() {
  const { cid } = useSnapshot();
  const authority = useActingAuthority();
  const actor = authority.human?.id ?? null;
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const key = params.get("template");
  const from = params.get("from");
  const [templates, setTemplates] = useState<TemplateSummary[] | null>(null);
  // "Customize steps" on the Release home brings its values along.
  const seed = (useLocation().state ?? null) as { params?: Record<string, unknown>; roles?: Record<string, string | null> | null; dryRun?: boolean } | null;
  const [values, setValues] = useState<Record<string, unknown>>(seed?.params ?? {});
  const [removed, setRemoved] = useState<string[]>([]);
  const [added, setAdded] = useState<AddedStep[]>([]);
  const [roles, setRoles] = useState<Record<string, string | null>>(seed?.roles ?? {});
  const [dryRun, setDryRun] = useState(!!seed?.dryRun);
  const [compiled, setCompiled] = useState<Compiled | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const [picker, setPicker] = useState<string | null>(null);
  const [plugged, setPlugged] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [saved, setSaved] = useState("");
  const [said, say] = useAnnounce();
  const lineRef = useRef<HTMLDivElement>(null);
  const seq = useRef(0);
  const seeded = useRef(false);

  useEffect(() => {
    if (!cid || key) return;
    flowApi.templates(cid, actor).then((t) => setTemplates(t.templates)).catch((e: Error) => setError(e.message));
  }, [cid, key, actor]);

  useEffect(() => {
    if (!cid || !from || seeded.current) return;
    seeded.current = true;
    flowApi.nextRelease(from, actor).then((n) => { setValues(n.params); setRemoved(n.removed); }).catch(() => {});
  }, [cid, from, actor]);

  const input = useMemo(() => ({ params: values, removed, added, roles, dry_run: dryRun }), [values, removed, added, roles, dryRun]);
  const debounced = useDebounced(input, 600);

  useEffect(() => {
    if (!cid || !key) return;
    const mine = ++seq.current;
    const ctrl = new AbortController();
    setChecking(true);
    flowApi.compile(cid, key, actor, debounced, ctrl.signal)
      .then((c) => {
        if (mine !== seq.current) return; // a newer check started: drop this answer
        setCompiled(c);
        setError("");
        if (!Object.keys(values).length) {
          const defaults: Record<string, unknown> = {};
          for (const p of c.parameters) if (p.default !== undefined) defaults[p.key] = p.default;
          setValues((v) => (Object.keys(v).length ? v : defaults));
        }
        if (!Object.keys(roles).length && c.people.length) {
          const humans = c.people.filter((x) => x.kind === "human");
          const me = humans.find((x) => x.id === actor) ?? humans[0];
          setRoles((r) => (Object.keys(r).length ? r : { owner: me?.id ?? null }));
        }
      })
      .catch((e: Error) => { if (e.name !== "AbortError" && mine === seq.current) setError(e.message); })
      .finally(() => { if (mine === seq.current) setChecking(false); });
    return () => ctrl.abort();
  }, [cid, key, actor, JSON.stringify(debounced)]);

  if (!cid) return <div className="fl-wrap"><p className="fl-muted">Choose a project first.</p></div>;

  if (!key) {
    return (
      <div className="fl-wrap">
        <header className="fl-head">
          <div><h1 className="fl-h1">New workflow</h1><p className="fl-sub">Pick a template. You can remove what you don't need before you start.</p></div>
          <button type="button" className="fl-btn" data-variant="ghost" onClick={() => navigate(flowHref("/workflows", cid))}><ArrowLeft size={14} />All workflows</button>
        </header>
        {error ? <p className="fl-problem" role="alert">{error}</p> : null}
        {templates ? <Gallery templates={templates} onPick={(k) => navigate(flowHref("/workflows/new", cid, { template: k, ...(templates.find((t) => t.key === k)?.has_inventory ? { home: "1" } : {}) }))}
          onBlank={() => navigate(flowHref("/workflows/new", cid, { blank: "1" }))}
          onImport={async (json) => {
            try { const s = await flowApi.importTemplate(cid, actor, json); navigate(flowHref("/workflows/new", cid, { template: s.key })); }
            catch (e) { setError((e as Error).message); }
          }} /> : <p className="fl-muted">Loading templates…</p>}
      </div>
    );
  }

  const c = compiled;
  const byStage = new Map<string, CompiledStep[]>();
  for (const s of c?.steps ?? []) byStage.set(s.stage, [...(byStage.get(s.stage) ?? []), s]);
  const names = Object.fromEntries((c?.steps ?? []).map((s) => [s.client_key, s.title]));
  const problemsOf = (k: string) => (c?.problems ?? []).filter((p) => p.task_id === k).map((p) => p.message);
  const loose = (c?.problems ?? []).filter((p) => !p.task_id || !names[p.task_id]);
  const paramProblems = new Set((c?.problems ?? []).filter((p) => p.code === "parameter_required").map((p) => p.param));
  const people = c?.people ?? [];
  const agentName = (id: string | null | undefined) => people.find((p) => p.id === id)?.alias;
  const assigneeOf = (s: CompiledStep) => {
    if (s.kind === "person" || s.kind === "gate") return agentName(roles.owner) ?? "You";
    if (s.kind === "watch") return "Watched for you";
    if (dryRun) return "Dry run stub";
    return agentName(roles[s.role ?? ""]) ?? (s.kind === "qa" ? "Your QA agent" : `Pick a ${s.role ?? "agent"}`);
  };
  const toggle = (s: CompiledStep) => {
    setRemoved((r) => (r.includes(s.client_key) ? r.filter((x) => x !== s.client_key) : [...r, s.client_key]));
    say(`${s.title} ${removed.includes(s.client_key) ? "added back" : "removed"}.`);
  };
  const kept = (c?.steps ?? []).filter((s) => !s.removed);
  const ready = !!c && !checking && c.problems.length === 0 && JSON.stringify(debounced) === JSON.stringify(input);
  const visibleParams = (c?.parameters ?? []).filter((p) => !p.hidden && (!p.platform || ((values.platforms as string[]) ?? []).includes(p.platform)));
  let stageIndex = 0;
  let stepIndex = 0;

  async function start() {
    if (!c || !key || !cid) return;
    setStarting(true);
    setError("");
    try {
      const d = await flowApi.create(cid, actor, { key, ...input, start: true });
      navigate(flowHref(`/workflows/${encodeURIComponent(d.id)}`, cid), { state: { justStarted: true } });
    } catch (e) {
      const fe = e as FlowError;
      setError(fe.message);
      setStarting(false);
    }
  }

  async function saveCopy() {
    if (!c || !key || !cid) return;
    const name = window.prompt("Name this project's copy", `${c.template.name} (${cid.slice(0, 4)})`);
    if (!name) return;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "my_template";
    try {
      await flowApi.saveVariant(cid, actor, { from_key: key, key: slug, name, params: values, removed, added, roles });
      setSaved(`Saved as ${name}. It's in the gallery for next time.`);
    } catch (e) { setError((e as Error).message); }
  }

  return (
    <div className="fl-wrap">
      <header className="fl-head">
        <div>
          <h1 className="fl-h1">{c?.template.name ?? "Loading…"}</h1>
          <p className="fl-sub">{c ? `${kept.length} steps in ${c.stages.length} stages${removed.length ? ` · ${removed.length} removed` : ""}` : "Reading the template…"}</p>
        </div>
        <div className="fl-head-actions">
          <button type="button" className="fl-btn" data-variant="ghost" onClick={() => navigate(flowHref("/workflows/new", cid))}><ArrowLeft size={14} />Templates</button>
          <a className="fl-btn" data-variant="ghost" href={flowApi.exportUrl(cid, key)} download><Download size={14} />Export</a>
          <button type="button" className="fl-btn" onClick={saveCopy} disabled={!c}><Save size={14} />Save as this project's</button>
        </div>
      </header>
      {saved ? <p className="fl-chip" data-tone="ok" role="status" style={{ alignSelf: "flex-start" }}>{saved}</p> : null}
      <div className="fl-editor">
        <aside className="fl-panel fl-params" aria-label="Parameters">
          <h2 className="fl-h2">This release</h2>
          {visibleParams.filter((p) => !p.advanced).map((p) => (
            <ParamField key={p.key} p={p} value={values[p.key]} invalid={paramProblems.has(p.key)} onChange={(v) => setValues((o) => ({ ...o, [p.key]: v }))} />
          ))}
          <div className="fl-field">
            <span className="fl-label">Who does what</span>
            <div className="fl-roles">
              {(c?.roles ?? []).map((r) => (
                <Fragment key={r.key}>
                  <label htmlFor={`fl-role-${r.key}`} style={{ fontSize: 12.5, color: "var(--v2-text-2)" }}>{r.label}</label>
                  <select id={`fl-role-${r.key}`} className="fl-select" value={roles[r.key] ?? ""} disabled={dryRun && r.kind === "ai"}
                    onChange={(e) => setRoles((o) => ({ ...o, [r.key]: e.target.value || null }))}>
                    <option value="">{r.kind === "human" ? "Me" : dryRun ? "Stubbed in a dry run" : r.key === "qa" ? "Your QA agent" : "Choose an agent"}</option>
                    {people.filter((x) => x.kind === r.kind).map((x) => <option key={x.id} value={x.id}>{x.alias}</option>)}
                  </select>
                </Fragment>
              ))}
            </div>
          </div>
          {visibleParams.some((p) => p.advanced) ? (
            <button type="button" className="fl-btn" data-variant="ghost" aria-expanded={advanced} onClick={() => setAdvanced((a) => !a)} style={{ alignSelf: "flex-start" }}>
              {advanced ? <ChevronUp size={13} /> : <ChevronDown size={13} />}Branch and status commands
            </button>
          ) : null}
          {advanced ? visibleParams.filter((p) => p.advanced).map((p) => (
            <ParamField key={p.key} p={p} value={values[p.key]} invalid={paramProblems.has(p.key)} onChange={(v) => setValues((o) => ({ ...o, [p.key]: v }))} />
          )) : null}
        </aside>
        <section aria-label="Steps">
          <div className="fl-line" ref={lineRef}>
            {c ? <span className="fl-line-rule" aria-hidden="true" /> : null}
            {c ? <LoopBrackets loops={c.loops} host={lineRef} sig={`${kept.map((s) => s.client_key).join()}|${c.loops.map((l) => l.members.join()).join(";")}`} /> : null}
            <ol className="fl-steps">
              {c?.stages.map((st) => {
                const steps = byStage.get(st.key) ?? [];
                if (!steps.length) return null;
                const n = ++stageIndex;
                return (
                  <Fragment key={st.key}>
                    <li className="fl-waypoint" style={{ ["--i" as string]: stepIndex }} aria-hidden="true">
                      <span className="fl-waypoint-dot">{n}</span><span className="fl-waypoint-title">{st.title}</span>
                    </li>
                    {steps.map((s) => (
                      <StepCard key={s.client_key} s={s} i={stepIndex++} problems={problemsOf(s.client_key)} plug={plugged === s.client_key} names={names}
                        assignee={assigneeOf(s)} onToggle={() => toggle(s)} onAddAfter={() => setPicker(s.client_key)} />
                    ))}
                  </Fragment>
                );
              })}
            </ol>
          </div>
        </section>
      </div>
      <div className="fl-startbar" role="region" aria-label="Start">
        <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
          <span className="fl-check" data-ok={c ? String(ready) : undefined} aria-live="polite">
            {checking || !c ? <><span className="fl-spin" aria-hidden="true" />Checking…</> : ready ? <>Ready to start</> : <><TriangleAlert size={14} aria-hidden="true" />{c.problems.length} to fix before Start</>}
          </span>
          {!checking && loose.slice(0, 3).map((p, i) => <span key={i} className="fl-problem" data-tone="warn">{p.message}</span>)}
          {error ? <span className="fl-problem" role="alert">{error}</span> : null}
        </div>
        <div className="fl-head-actions">
          <label style={{ display: "inline-flex", gap: 8, alignItems: "center", fontSize: 13, color: "var(--v2-text-2)" }}>
            <button type="button" role="switch" className="fl-switch" aria-checked={dryRun} onClick={() => setDryRun((d) => !d)} aria-label="Dry run" data-dry-run />
            Dry run <span className="fl-help">(stubs agents, QA and stores; only you decide)</span>
          </label>
          <button type="button" className="fl-btn" data-variant="primary" data-size="lg" disabled={!ready || starting} onClick={start} data-start>
            <Play size={15} />{starting ? "Starting…" : dryRun ? "Start the dry run" : "Start"}
          </button>
        </div>
      </div>
      <p className="fl-sr" aria-live="polite">{said}</p>
      {picker ? <Picker onClose={() => setPicker(null)} onPick={(p, title) => {
        const k = `added_${Date.now().toString(36)}`;
        const outcomes = p.kind === "qa" ? [{ name: "pass", kind: "success" }, { name: "fail", kind: "failure" }]
          : p.kind === "watch" ? [{ name: "done", kind: "success" }] : p.outcomes;
        setAdded((a) => [...a, {
          client_key: k, title, kind: p.kind, insert_after: picker, role: p.kind === "agent" ? "engineer" : p.kind === "qa" ? "qa" : null,
          definition_of_done: p.kind === "gate" ? "You chose Go or No-go." : p.kind === "person" ? "You did it and said so." : p.kind === "watch" ? "The status says done." : "Its proof is posted.",
          description: p.hint, outcomes,
          routes: outcomes?.map((o) => ({ outcome: o.name, destination: o.kind === "failure" ? (p.kind === "qa" ? "ask_owner" : "stop") : "next" })),
          ...(p.kind === "qa" ? { qa: { kind: "check" as const, focus: title }, dry_run: { outcomes: ["pass"] } } : {}),
          ...(p.kind === "watch" ? { watch: { adapter: { command: "python3 scripts/release-adapters/status.py" }, interval_s: 300, state_map: { done: "done", live: "done" }, dry_run_states: ["waiting", "done"] } } : {}),
        }]);
        setPlugged(k);
        setPicker(null);
        say(`${title} added after ${names[picker] ?? "the step"}.`);
        requestAnimationFrame(() => setTimeout(() => document.querySelector(`[data-key="${CSS.escape(k)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 700));
      }} /> : null}
    </div>
  );
}

export { KIND_WORD };
