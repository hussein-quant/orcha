/**
 * A release cycle: two or three weeks of tickets on one release branch, then one release.
 *
 * Every ticket (a GitHub issue from the cycle's milestone, or one typed here) runs as its own small
 * workflow: a spec you approve for a feature, a PR into the release branch, your merge, a check on
 * staging on its platforms. Your merge is the decision that it ships. The cut sends what's merged
 * to the Release home to start the release from the branch; what isn't merged rolls to the next
 * cycle.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useActingAuthority, useSnapshot } from "../../state/SnapshotProvider";
import { ArrowLeft, ArrowRight, Bug, ExternalLink, GitBranch, Plus, RefreshCw, Search, Sparkles, TriangleAlert, X } from "./icons";
import {
  ago, cycleApi, flowApi, PLATFORM_WORD, type Compiled, type Cycle, type CycleTicket, type GithubIssue, type Platform,
} from "./flowApi";
import { flowHref } from "./Board";
import { Figure, Thread } from "./kit";
import { guessRoles } from "./ReleaseHome";
import { Intake } from "./Intake";

const ALL: Platform[] = ["ios", "android", "web", "api"];
type People = Compiled["people"];

function usePeople(cid: string | null, actor: string | null): People {
  const [people, setPeople] = useState<People>([]);
  useEffect(() => {
    if (!cid) return;
    const ctrl = new AbortController();
    // The ticket template's live check lists the project's people; nothing is created.
    flowApi.compile(cid, "release_ticket", actor, { params: {}, removed: [], added: [], roles: {}, dry_run: true }, ctrl.signal)
      .then((c) => setPeople(c.people)).catch(() => setPeople([]));
    return () => ctrl.abort();
  }, [cid, actor]);
  return people;
}

function PlatformToggles({ value, onChange, allowed = ALL, label }: { value: Platform[]; onChange: (v: Platform[]) => void; allowed?: Platform[]; label: string }) {
  return (
    <div className="fl-toggles" role="group" aria-label={label}>
      {allowed.map((p) => (
        <button key={p} type="button" className="fl-toggle" aria-pressed={value.includes(p)} data-platform={p}
          onClick={() => onChange(value.includes(p) ? value.filter((x) => x !== p) : ALL.filter((x) => x === p || value.includes(x)))}>
          {PLATFORM_WORD[p]}
        </button>
      ))}
    </div>
  );
}

function AgentPick({ label, value, people, onChange, empty = "Choose…" }: { label: string; value: string | null | undefined; people: People; onChange: (v: string | null) => void; empty?: string }) {
  return (
    <label className="fl-cmp-pill" data-empty={!value || undefined}>
      <span className="fl-muted">{label}</span>
      <select aria-label={label} value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">{empty}</option>
        {people.filter((x) => x.kind === "ai").map((x) => <option key={x.id} value={x.id}>{x.alias}</option>)}
      </select>
    </label>
  );
}

/* ---- opening a cycle ---------------------------------------------------------------- */

function OpenCycle({ cid, actor, suggested, onOpened }: { cid: string; actor: string | null; suggested: string | null; onOpened: (c: Cycle) => void }) {
  const people = usePeople(cid, actor);
  const [version, setVersion] = useState(suggested ?? "");
  const [branch, setBranch] = useState("");
  const [base, setBase] = useState("main");
  const [milestone, setMilestone] = useState("");
  const [platforms, setPlatforms] = useState<Platform[]>(ALL);
  const [roles, setRoles] = useState<Record<string, string | null>>({});
  const [engineers, setEngineers] = useState<Record<string, string | null>>({});
  const [makeBranch, setMakeBranch] = useState(true);
  const [dryRun, setDryRun] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (suggested || version) return;
    // No cycle yet: the release inventory knows the next version.
    const ctrl = new AbortController();
    flowApi.inventory(cid, "mobile_app_release", actor, false, ctrl.signal)
      .then((inv) => { const v = inv.data.release_params?.version; if (typeof v === "string") setVersion((cur) => cur || v); })
      .catch(() => undefined);
    return () => ctrl.abort();
  }, [cid]);
  useEffect(() => {
    if (!people.length) return;
    const g = guessRoles(people, actor);
    setRoles((r) => (Object.keys(r).length ? r : { engineer: g.engineer, release: g.release, qa: g.qa }));
    const ai = people.filter((p) => p.kind === "ai");
    const by = (re: RegExp) => ai.find((a) => re.test(a.alias))?.id ?? null;
    setEngineers((e) => (Object.keys(e).length ? e : { ios: by(/ios|iphone/i), android: by(/android/i), web: by(/\bweb|front/i), api: by(/\bapi|back/i) }));
  }, [people.length]);

  const v = version.trim();
  const theBranch = branch.trim() || (v ? `release/${v}` : "");
  async function open() {
    setBusy(true); setError("");
    try {
      onOpened(await cycleApi.open(cid, actor, {
        version: v, branch: theBranch, base_branch: base.trim() || "main", milestone: milestone.trim() || undefined, platforms,
        roles, engineers, create_branch: makeBranch, dry_run: dryRun,
      }));
    } catch (e) { setError((e as Error).message); setBusy(false); }
  }
  const why = !v ? "Choose the version." : !platforms.length ? "Choose at least one platform." : !roles.engineer && !dryRun ? "Choose who builds the tickets." : "";
  return (
    <div className="fl-wrap fl-cy">
      <header className="fl-head">
        <div>
          <h1 className="fl-h1">Open a release cycle</h1>
          <p className="fl-sub">Tickets collect on one release branch for the next two or three weeks. What you merge into it ships.</p>
        </div>
        <div className="fl-head-actions"><Link className="fl-btn" data-variant="ghost" to={flowHref("/workflows", cid)}><ArrowLeft size={14} />Workflows</Link></div>
      </header>
      <section className="fl-panel" aria-label="The cycle">
        <div className="fl-cy-grid">
          <div className="fl-field"><label htmlFor="cy-version">Version</label>
            <input id="cy-version" className="fl-input fl-mono" value={version} placeholder="1.0.3" onChange={(e) => setVersion(e.target.value)} /></div>
          <div className="fl-field"><label htmlFor="cy-branch">Release branch</label>
            <input id="cy-branch" className="fl-input fl-mono" value={branch} placeholder={theBranch || "release/1.0.3"} onChange={(e) => setBranch(e.target.value)} /></div>
          <div className="fl-field"><label htmlFor="cy-base">Cut from</label>
            <input id="cy-base" className="fl-input fl-mono" value={base} onChange={(e) => setBase(e.target.value)} /></div>
          <div className="fl-field"><label htmlFor="cy-milestone">GitHub milestone</label>
            <input id="cy-milestone" className="fl-input" value={milestone} placeholder={v || "1.0.3"} onChange={(e) => setMilestone(e.target.value)} />
            <span className="fl-help">Its open issues can be added as tickets.</span></div>
        </div>
        <div className="fl-field"><span className="fl-label">Platforms this project ships</span>
          <PlatformToggles value={platforms} onChange={setPlatforms} label="Platforms" /></div>
        <div className="fl-field"><span className="fl-label">Who works on the tickets</span>
          <div className="fl-rh-roles">
            <AgentPick label="Engineer" value={roles.engineer} people={people} onChange={(x) => setRoles({ ...roles, engineer: x })} />
            <AgentPick label="Release" value={roles.release} people={people} onChange={(x) => setRoles({ ...roles, release: x })} />
            <AgentPick label="QA" value={roles.qa} people={people} onChange={(x) => setRoles({ ...roles, qa: x })} />
          </div>
          <div className="fl-rh-roles">
            {platforms.map((p) => <AgentPick key={p} label={`${PLATFORM_WORD[p]} only`} value={engineers[p]} people={people} empty="Same engineer" onChange={(x) => setEngineers({ ...engineers, [p]: x })} />)}
          </div>
          <span className="fl-help">A ticket for one platform goes to that platform's engineer when you choose one.</span>
        </div>
      </section>
      <div className="fl-startbar fl-rh-start" role="region" aria-label="Open the cycle">
        <div className="fl-rh-start-main">
          <span className="fl-rh-label">{v ? <>Open <b className="fl-mono">{v}</b> on <span className="fl-mono">{theBranch}</span></> : "Open a cycle"}</span>
          {!dryRun ? (
            <label className="fl-cy-check"><input type="checkbox" checked={makeBranch} onChange={(e) => setMakeBranch(e.target.checked)} />
              Create <span className="fl-mono">{theBranch || "the branch"}</span> on origin from <span className="fl-mono">{base || "main"}</span></label>
          ) : <span className="fl-help">Dry run: no branch, and no agent wakes. People's steps still wait for you.</span>}
          {why ? <span className="fl-help" aria-live="polite">{why}</span> : null}
          {error ? <span className="fl-problem" role="alert"><TriangleAlert size={13} />{error}</span> : null}
        </div>
        <div className="fl-head-actions">
          <label style={{ display: "inline-flex", gap: 8, alignItems: "center", fontSize: 13, color: "var(--v2-text-2)" }}>
            <button type="button" role="switch" className="fl-switch" aria-checked={dryRun} onClick={() => setDryRun((d) => !d)} aria-label="Dry run" />Dry run
          </label>
          <button type="button" className="fl-btn" data-variant="primary" data-size="lg" disabled={!!why || busy} onClick={open} data-open-cycle>
            <GitBranch size={15} />{busy ? "Opening…" : "Open the cycle"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---- tickets ------------------------------------------------------------------------- */

function TicketRow({ t, cycle, cid, actor, onChanged, i }: { t: CycleTicket; cycle: Cycle; cid: string; actor: string | null; onChanged: (c: Cycle) => void; i: number }) {
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState("");
  const Kind = t.kind === "feature" ? Sparkles : Bug;
  const ref = t.issue_number ? `#${t.issue_number}` : null;
  const body = (
    <>
      <span className="fl-row-icon" aria-hidden="true" data-kind={t.kind}><Kind size={17} /></span>
      <span className="fl-row-main">
        <span className="fl-row-title">
          <span>{ref ? <b className="fl-mono">{ref} </b> : null}{t.title}</span>
          {t.rolled_from_cycle_id ? <span className="fl-chip" data-tone="muted">Rolled over</span> : null}
        </span>
        <Thread dots={t.thread} label={`${t.done} of ${t.total} steps done`} />
        <span className="fl-row-meta">
          <span>{t.kind === "feature" ? "Feature" : "Bug"}</span><span>·</span>
          {t.platforms.map((p) => <span key={p} className="fl-chip" data-tone="muted">{PLATFORM_WORD[p]}</span>)}
          {t.step && !t.needs_you ? <><span>·</span><span>{t.step.title}</span></> : null}
        </span>
      </span>
      <span className="fl-row-side">
        <span className="fl-chip" data-tone={t.tone === "asking" ? "warn" : t.tone === "running" ? "accent" : t.tone}>{t.word}</span>
        <span>{ago(t.created_at)}</span>
      </span>
    </>
  );
  const canDrop = cycle.state === "open" && t.state === "active" && !t.merged && t.workflow_status !== "cancelled";
  return (
    <li className="fl-cy-ticket" style={{ ["--i" as string]: i }} data-ticket={t.id} data-state={t.state}>
      {t.workflow_id ? <Link className="fl-row" data-kind="agent" to={flowHref(`/workflows/${encodeURIComponent(t.workflow_id)}`, cid)}>{body}</Link> : <div className="fl-row">{body}</div>}
      <span className="fl-cy-ticket-actions">
        {t.issue_url ? <a className="fl-btn" data-variant="ghost" href={t.issue_url} target="_blank" rel="noreferrer" aria-label={`Open ${ref ?? "the issue"} on GitHub`}><ExternalLink size={13} /></a> : null}
        {canDrop ? (confirm ? (
          <>
            <button type="button" className="fl-btn" data-variant="danger" onClick={async () => {
              try { onChanged(await cycleApi.dropTicket(cycle.id, t.id, actor)); } catch (e) { setError((e as Error).message); setConfirm(false); }
            }}>Take it out</button>
            <button type="button" className="fl-btn" data-variant="ghost" onClick={() => setConfirm(false)}>Keep</button>
          </>
        ) : <button type="button" className="fl-btn" data-variant="ghost" onClick={() => setConfirm(true)} aria-label={`Take ${ref ?? t.title} out of this release`}><X size={13} /></button>) : null}
      </span>
      {error ? <span className="fl-problem" role="alert">{error}</span> : null}
    </li>
  );
}

function AddTicket({ cycle, actor, people, onAdded, onClose }: { cycle: Cycle; actor: string | null; people: People; onAdded: (c: Cycle) => void; onClose: () => void }) {
  const [issue, setIssue] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [url, setUrl] = useState<string | null>(null);
  const [labels, setLabels] = useState<string[]>([]);
  const [kind, setKind] = useState<"bug" | "feature">("bug");
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [engineer, setEngineer] = useState<string | null>(null);
  const [busy, setBusy] = useState<"" | "read" | "add">("");
  const [error, setError] = useState("");
  const n = Number(issue.replace(/^#/, ""));
  const number = Number.isInteger(n) && n > 0 ? n : null;

  async function read() {
    if (!number) return;
    setBusy("read"); setError("");
    try {
      const i = await cycleApi.issue(cycle.id, number, actor);
      setTitle(i.title); setBody(i.body); setUrl(i.url); setLabels(i.labels);
      if (i.kind_from_labels) setKind(i.kind);
      if (i.platforms.length) setPlatforms(i.platforms.filter((p) => cycle.platforms.includes(p)));
    } catch (e) { setError((e as Error).message); }
    setBusy("");
  }
  async function add() {
    setBusy("add"); setError("");
    try {
      onAdded(await cycleApi.addTicket(cycle.id, actor, { issue_number: number, title: title.trim(), body, url, kind, platforms, engineer_id: engineer, labels, source: url ? "github" : "manual" }));
      onClose();
    } catch (e) { setError((e as Error).message); setBusy(""); }
  }
  const single = platforms.length === 1 ? cycle.engineers[platforms[0]] : undefined;
  const who = engineer ?? single ?? cycle.roles.engineer ?? null;
  const why = !title.trim() ? (number ? "Read the issue, or type its title." : "Type a title, or an issue number to read.") : !platforms.length ? "Choose the platforms it touches." : "";
  return (
    <section className="fl-panel fl-cy-add" aria-label="Add a ticket">
      <header className="fl-cy-panel-head"><h2 className="fl-h2">Add a ticket</h2>
        <button type="button" className="fl-btn" data-variant="ghost" onClick={onClose} aria-label="Close"><X size={14} /></button></header>
      <div className="fl-cy-grid">
        <div className="fl-field"><label htmlFor="cy-issue">GitHub issue</label>
          <span className="fl-cy-inline">
            <input id="cy-issue" className="fl-input fl-mono" value={issue} placeholder="#212" inputMode="numeric" onChange={(e) => setIssue(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void read(); } }} />
            <button type="button" className="fl-btn" disabled={!number || !!busy} onClick={read}><Search size={13} />{busy === "read" ? "Reading…" : "Read"}</button>
          </span></div>
        <div className="fl-field" style={{ gridColumn: "span 3" }}><label htmlFor="cy-title">Title</label>
          <input id="cy-title" className="fl-input" value={title} placeholder="Login spinner never stops on a slow network" onChange={(e) => setTitle(e.target.value)} /></div>
      </div>
      <div className="fl-cy-row">
        <div className="fl-field"><span className="fl-label">Kind</span>
          <div className="fl-toggles" role="radiogroup" aria-label="Kind">
            <button type="button" role="radio" className="fl-toggle" aria-checked={kind === "bug"} aria-pressed={kind === "bug"} onClick={() => setKind("bug")}><Bug size={13} />Bug</button>
            <button type="button" role="radio" className="fl-toggle" aria-checked={kind === "feature"} aria-pressed={kind === "feature"} onClick={() => setKind("feature")}><Sparkles size={13} />Feature</button>
          </div>
          <span className="fl-help">{kind === "feature" ? "A feature starts with a spec you approve." : "A bug goes straight to a fix."}</span></div>
        <div className="fl-field"><span className="fl-label">Platforms</span>
          <PlatformToggles value={platforms} onChange={setPlatforms} allowed={cycle.platforms} label="Platforms" />
          <span className="fl-help">{platforms.includes("api") ? "An API change is checked on every app too." : "Checked on these only."}</span></div>
        <div className="fl-field"><span className="fl-label">Engineer</span>
          <AgentPick label="Builds it" value={who} people={people} onChange={setEngineer} /></div>
      </div>
      <div className="fl-field"><label htmlFor="cy-body">Details</label>
        <textarea id="cy-body" className="fl-textarea" value={body} placeholder="What happens, where, and what should happen instead." onChange={(e) => setBody(e.target.value)} /></div>
      <footer className="fl-cy-panel-foot">
        {error ? <span className="fl-problem" role="alert"><TriangleAlert size={13} />{error}</span> : why ? <span className="fl-help">{why}</span> : <span className="fl-help">It starts right away: a PR into <span className="fl-mono">{cycle.branch}</span>, then your merge.</span>}
        <button type="button" className="fl-btn" data-variant="primary" disabled={!!why || !!busy} onClick={add} data-add-ticket><Plus size={14} />{busy === "add" ? "Adding…" : "Add and start"}</button>
      </footer>
    </section>
  );
}

function FromGithub({ cycle, actor, onAdded, onClose }: { cycle: Cycle; actor: string | null; onAdded: (c: Cycle) => void; onClose: () => void }) {
  const [data, setData] = useState<{ milestone: string; issues: GithubIssue[]; error: string | null } | null>(null);
  const [picked, setPicked] = useState<Record<number, Platform[]>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [milestone, setMilestone] = useState(cycle.milestone ?? cycle.version);
  function read() {
    setData(null); setError("");
    cycleApi.github(cycle.id, actor).then(setData).catch((e: Error) => setError(e.message));
  }
  useEffect(read, [cycle.id, cycle.milestone]);
  const free = (data?.issues ?? []).filter((i) => !i.in_cycle);
  const chosen = Object.entries(picked);
  async function add() {
    setBusy(true); setError("");
    let last: Cycle | null = null;
    for (const [n, platforms] of chosen) {
      const i = data!.issues.find((x) => x.number === Number(n))!;
      try {
        last = await cycleApi.addTicket(cycle.id, actor, { issue_number: i.number, title: i.title, body: i.body, url: i.url, kind: i.kind, platforms, labels: i.labels, source: "github" });
      } catch (e) { setError(`#${i.number}: ${(e as Error).message}`); break; }
    }
    setBusy(false);
    if (last) { onAdded(last); setPicked({}); read(); }
  }
  return (
    <section className="fl-panel fl-cy-add" aria-label="Add from GitHub">
      <header className="fl-cy-panel-head">
        <h2 className="fl-h2">Milestone <span className="fl-mono">{data?.milestone ?? milestone}</span> on GitHub</h2>
        <span className="fl-head-actions">
          <button type="button" className="fl-btn" data-variant="ghost" onClick={read}><RefreshCw size={13} />Read again</button>
          <button type="button" className="fl-btn" data-variant="ghost" onClick={onClose} aria-label="Close"><X size={14} /></button>
        </span>
      </header>
      {!data && !error ? <p className="fl-muted" aria-busy="true">Reading the milestone's open issues…</p> : null}
      {data?.error ? (
        <div className="fl-cy-gh-error" role="alert">
          <p className="fl-problem" data-tone="warn"><TriangleAlert size={13} />Couldn't read the milestone: {data.error}</p>
          <span className="fl-cy-inline">
            <input className="fl-input" aria-label="Milestone" value={milestone} onChange={(e) => setMilestone(e.target.value)} />
            <button type="button" className="fl-btn" onClick={async () => { try { onAdded(await cycleApi.settings(cycle.id, actor, { milestone })); } catch (e) { setError((e as Error).message); } }}>Use this milestone</button>
          </span>
          <span className="fl-help">The issues are read with <span className="fl-mono">gh</span> in the project folder. Nothing on GitHub changes.</span>
        </div>
      ) : null}
      {data && !data.error ? (data.issues.length ? (
        <ul className="fl-cy-gh">
          {data.issues.map((i) => {
            const on = i.number in picked;
            const plats = picked[i.number] ?? i.platforms.filter((p) => cycle.platforms.includes(p));
            return (
              <li key={i.number} data-in={!!i.in_cycle}>
                <label className="fl-cy-gh-pick">
                  <input type="checkbox" disabled={!!i.in_cycle} checked={on} onChange={() => setPicked((cur) => {
                    const next = { ...cur };
                    if (on) delete next[i.number]; else next[i.number] = plats;
                    return next;
                  })} />
                  <b className="fl-mono">#{i.number}</b><span>{i.title}</span>
                </label>
                <span className="fl-rh-tags">
                  <span className="fl-chip" data-tone="muted">{i.kind === "feature" ? "Feature" : "Bug"}</span>
                  {i.in_cycle ? <span className="fl-chip" data-tone="info">In {i.in_cycle}</span>
                    : on ? <PlatformToggles value={plats} allowed={cycle.platforms} onChange={(v) => setPicked({ ...picked, [i.number]: v })} label={`Platforms for #${i.number}`} />
                    : plats.length ? plats.map((p) => <span key={p} className="fl-chip" data-tone="muted">{PLATFORM_WORD[p]}</span>)
                    : <span className="fl-chip" data-tone="warn">No platform label</span>}
                </span>
              </li>
            );
          })}
        </ul>
      ) : <p className="fl-muted">No open issues in this milestone.</p>) : null}
      <footer className="fl-cy-panel-foot">
        {error ? <span className="fl-problem" role="alert"><TriangleAlert size={13} />{error}</span>
          : chosen.some(([, p]) => !p.length) ? <span className="fl-help">Choose platforms for the issues without a platform label.</span>
          : <span className="fl-help">{free.length} not in a cycle yet. Platforms and kind come from labels; change them before adding.</span>}
        <button type="button" className="fl-btn" data-variant="primary" disabled={!chosen.length || busy || chosen.some(([, p]) => !p.length)} onClick={add}>
          <Plus size={14} />{busy ? "Adding…" : `Add ${chosen.length || ""} ${chosen.length === 1 ? "ticket" : "tickets"}`.replace("  ", " ")}
        </button>
      </footer>
    </section>
  );
}

/* ---- the cycle ------------------------------------------------------------------------ */

const BRANCH_WORD: Record<Cycle["branch_state"], { word: string; tone: string }> = {
  created: { word: "Branch created", tone: "ok" }, existed: { word: "Branch on origin", tone: "ok" },
  pending: { word: "Branch not made yet", tone: "warn" }, failed: { word: "Branch failed", tone: "danger" },
  skipped: { word: "Dry run, no branch", tone: "info" },
};

function Group({ title, children, count }: { title: string; children: ReactNode; count: number }) {
  if (!count) return null;
  return (
    <section className="fl-board" aria-label={title}>
      <h2 className="fl-section-title">{title} <span className="fl-mono fl-muted">{count}</span></h2>
      <ul className="fl-rows">{children}</ul>
    </section>
  );
}

function CycleView({ cycle, cid, actor, setCycle, startWith }: { cycle: Cycle; cid: string; actor: string | null; setCycle: (c: Cycle) => void; startWith?: "intake" | "" }) {
  const navigate = useNavigate();
  const people = usePeople(cid, actor);
  const [panel, setPanel] = useState<"" | "add" | "github" | "intake">(startWith ?? "");
  const [filter, setFilter] = useState<Platform | "all">("all");
  const [error, setError] = useState("");
  const tickets = (cycle.tickets ?? []).filter((t) => filter === "all" || t.platforms.includes(filter));
  const live = tickets.filter((t) => t.state !== "dropped" && t.workflow_status !== "cancelled");
  const needs = live.filter((t) => t.state === "active" && t.needs_you);
  const going = live.filter((t) => t.state === "active" && !t.needs_you && !t.merged);
  const inBranch = live.filter((t) => t.merged || t.state === "shipped");
  const out = tickets.filter((t) => t.state === "dropped" || t.workflow_status === "cancelled");
  const open = cycle.state === "open";
  const b = BRANCH_WORD[cycle.branch_state];
  const ships = cycle.cut.ships.length;
  const rolls = cycle.cut.rolls.length;
  const unchecked = cycle.cut.unchecked.length;
  return (
    <div className="fl-wrap fl-cy">
      <nav><Link className="fl-btn" data-variant="ghost" to={flowHref("/workflows", cid)}><ArrowLeft size={14} />All workflows</Link></nav>
      <header className="fl-head">
        <div>
          <h1 className="fl-h1">Release {cycle.version} {cycle.dry_run ? <span className="fl-chip" data-tone="info">Dry run</span> : null}
            <span className="fl-chip" data-tone={open ? "accent" : "muted"}>{open ? "Collecting" : cycle.state === "cut" ? "Cut" : "Closed"}</span></h1>
          <p className="fl-sub fl-cy-branch">
            <GitBranch size={13} aria-hidden="true" /><span className="fl-mono">{cycle.branch}</span>
            <span>from <span className="fl-mono">{cycle.base_branch}</span></span>
            <span className="fl-chip" data-tone={b.tone} title={cycle.branch_note ?? undefined}>{b.word}</span>
            {open && (cycle.branch_state === "failed" || cycle.branch_state === "pending") ? (
              <button type="button" className="fl-linkbtn" onClick={async () => { try { setCycle(await cycleApi.branch(cycle.id, actor)); } catch (e) { setError((e as Error).message); } }}>
                {cycle.branch_state === "failed" ? "Try again" : "Create it now"}</button>
            ) : null}
            <span>· opened {ago(cycle.created_at)}</span>
            {cycle.previous_cycle ? <Link to={flowHref("/workflows/cycle", cid, { cycle: cycle.previous_cycle.id })}>after {cycle.previous_cycle.version}</Link> : null}
          </p>
          {cycle.branch_state === "failed" && cycle.branch_note ? <p className="fl-problem" role="alert"><TriangleAlert size={13} />{cycle.branch_note}</p> : null}
        </div>
        {open ? (
          <div className="fl-head-actions">
            <button type="button" className="fl-btn" aria-pressed={panel === "github"} onClick={() => setPanel(panel === "github" ? "" : "github")} data-from-github>
              <GitBranch size={14} />From GitHub</button>
            <button type="button" className="fl-btn" aria-pressed={panel === "add"} onClick={() => setPanel(panel === "add" ? "" : "add")} data-add><Plus size={14} />Add ticket</button>
            <button type="button" className="fl-btn" data-variant="primary" aria-pressed={panel === "intake"} onClick={() => setPanel(panel === "intake" ? "" : "intake")} data-intake>
              <Sparkles size={14} />Log an issue</button>
          </div>
        ) : null}
      </header>
      {error ? <p className="fl-problem" role="alert"><TriangleAlert size={13} />{error}</p> : null}

      {!open ? (
        <section className="fl-panel fl-cy-cut-done" role="status">
          <p>Cut {cycle.cut_at ? ago(cycle.cut_at) : ""}. {ships} {ships === 1 ? "ticket ships" : "tickets ship"} in this release.</p>
          <span className="fl-head-actions">
            {cycle.release_workflow ? <Link className="fl-btn" data-variant="primary" to={flowHref(`/workflows/${encodeURIComponent(cycle.release_workflow.id)}`, cid)}>The release<ArrowRight size={14} /></Link> : null}
            {cycle.next_cycle ? <Link className="fl-btn" to={flowHref("/workflows/cycle", cid, { cycle: cycle.next_cycle.id })}>Next: {cycle.next_cycle.version}<ArrowRight size={14} /></Link> : null}
          </span>
        </section>
      ) : null}

      <div className="fl-figures" aria-label="This cycle">
        <Figure value={cycle.counts.total} label="tickets" />
        <Figure value={cycle.counts.merged} label="in the branch" tone="ok" />
        <Figure value={cycle.counts.checked} label="checked on staging" tone="ok" />
        <Figure value={cycle.counts.needs_you} label="waiting for you" tone={cycle.counts.needs_you ? "warn" : undefined} />
      </div>

      {panel === "add" ? <AddTicket cycle={cycle} actor={actor} people={people} onAdded={setCycle} onClose={() => setPanel("")} /> : null}
      {panel === "github" ? <FromGithub cycle={cycle} actor={actor} onAdded={setCycle} onClose={() => setPanel("")} /> : null}
      {panel === "intake" ? <Intake cycle={cycle} actor={actor} people={people} onLogged={setCycle} onClose={() => setPanel("")} /> : null}

      {(cycle.tickets ?? []).length ? (
        <div className="fl-toggles" role="radiogroup" aria-label="Show tickets for">
          {(["all", ...cycle.platforms] as const).map((p) => (
            <button key={p} type="button" role="radio" className="fl-toggle" aria-checked={filter === p} aria-pressed={filter === p} onClick={() => setFilter(p)}>
              {p === "all" ? "All" : PLATFORM_WORD[p]}
            </button>
          ))}
        </div>
      ) : open && !panel ? (
        <section className="fl-panel fl-cy-empty">
          <h2 className="fl-h2">No tickets yet</h2>
          <p className="fl-muted">Add the issues you want in {cycle.version}: talk them through with an agent, take them from the <span className="fl-mono">{cycle.milestone ?? cycle.version}</span> milestone on GitHub, or type them in. Each one starts right away and opens a PR into <span className="fl-mono">{cycle.branch}</span>.</p>
          <span className="fl-head-actions">
            <button type="button" className="fl-btn" data-variant="primary" onClick={() => setPanel("intake")}><Sparkles size={14} />Log an issue</button>
            <button type="button" className="fl-btn" onClick={() => setPanel("github")}><GitBranch size={14} />From GitHub</button>
            <button type="button" className="fl-btn" onClick={() => setPanel("add")}><Plus size={14} />Add ticket</button>
          </span>
        </section>
      ) : null}

      <Group title="Waiting for you" count={needs.length}>{needs.map((t, i) => <TicketRow key={t.id} t={t} i={i} cycle={cycle} cid={cid} actor={actor} onChanged={setCycle} />)}</Group>
      <Group title="Being built" count={going.length}>{going.map((t, i) => <TicketRow key={t.id} t={t} i={i} cycle={cycle} cid={cid} actor={actor} onChanged={setCycle} />)}</Group>
      <Group title={open ? "In the branch" : "Shipped"} count={inBranch.length}>{inBranch.map((t, i) => <TicketRow key={t.id} t={t} i={i} cycle={cycle} cid={cid} actor={actor} onChanged={setCycle} />)}</Group>
      <Group title="Taken out" count={out.length}>{out.map((t, i) => <TicketRow key={t.id} t={t} i={i} cycle={cycle} cid={cid} actor={actor} onChanged={setCycle} />)}</Group>

      {open ? (
        <div className="fl-startbar fl-rh-start" role="region" aria-label="Cut the release">
          <div className="fl-rh-start-main">
            <span className="fl-rh-label">
              {ships ? <><b>{ships}</b> {ships === 1 ? "ticket ships" : "tickets ship"}{cycle.cut.platforms.length ? <> on {cycle.cut.platforms.map((p) => PLATFORM_WORD[p]).join(", ")}</> : null}</> : "Nothing is merged into the branch yet"}
              {rolls ? <> · {rolls} {rolls === 1 ? "rolls" : "roll"} to <span className="fl-mono">{cycle.cut.next_version}</span></> : null}
            </span>
            <span className="fl-help">
              {unchecked ? `${unchecked} merged ${unchecked === 1 ? "ticket hasn't" : "tickets haven't"} passed its staging check yet; the full regression still covers it. ` : ""}
              The cut starts the release from <span className="fl-mono">{cycle.branch}</span> and opens <span className="fl-mono">{cycle.cut.next_branch}</span> for what's left.
            </span>
          </div>
          <button type="button" className="fl-btn" data-variant="primary" data-size="lg" disabled={!ships} data-cut
            onClick={() => navigate(flowHref("/workflows/new", cid, { template: "mobile_app_release", home: "1", cycle: cycle.id }))}>
            Cut the release<ArrowRight size={15} />
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function ReleaseCycle() {
  const { cid, bump, connection } = useSnapshot();
  const authority = useActingAuthority();
  const actor = authority.human?.id ?? null;
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const id = params.get("cycle");
  const fresh = params.get("new") === "1";
  const intake = params.get("intake") === "1";
  const [cycle, setCycle] = useState<Cycle | null>(null);
  const [suggested, setSuggested] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState("");
  const seq = useRef(0);

  useEffect(() => {
    if (!cid || id) return;
    const ctrl = new AbortController();
    cycleApi.list(cid, actor, ctrl.signal).then((l) => {
      const open = fresh ? null : l.open ?? l.open_dry_run;
      if (open) navigate(flowHref("/workflows/cycle", cid, { cycle: open, ...(intake ? { intake: "1" } : {}) }), { replace: true });
      else setSuggested(l.suggested.version);
    }).catch((e: Error) => { if (e.name !== "AbortError") setError(e.message); });
    return () => ctrl.abort();
  }, [cid, id, fresh]);

  const tick = useMemo(() => Math.floor(bump / (connection === "live" ? 5 : 2)), [bump, connection]);
  useEffect(() => {
    if (!id) return;
    const mine = ++seq.current;
    const ctrl = new AbortController();
    cycleApi.get(id, actor, ctrl.signal)
      .then((c) => { if (mine === seq.current) { setCycle(c); setError(""); } })
      .catch((e: Error) => { if (e.name !== "AbortError" && mine === seq.current) setError(e.message); });
    return () => ctrl.abort();
  }, [id, actor, tick]);

  if (!cid) return <div className="fl-wrap"><p className="fl-muted">Choose a project first.</p></div>;
  if (error && !cycle) return <div className="fl-wrap"><p className="fl-problem" role="alert"><TriangleAlert size={13} />{error}</p></div>;
  if (!id) {
    if (suggested === undefined) return <div className="fl-wrap"><p className="fl-muted" aria-busy="true">Loading the release cycle…</p></div>;
    return <OpenCycle cid={cid} actor={actor} suggested={suggested} onOpened={(c) => navigate(flowHref("/workflows/cycle", cid, { cycle: c.id }))} />;
  }
  if (!cycle) return <div className="fl-wrap"><p className="fl-muted" aria-busy="true">Loading the release cycle…</p></div>;
  return <CycleView cycle={cycle} cid={cid} actor={actor} setCycle={setCycle} startWith={intake && cycle.state === "open" ? "intake" : ""} />;
}
