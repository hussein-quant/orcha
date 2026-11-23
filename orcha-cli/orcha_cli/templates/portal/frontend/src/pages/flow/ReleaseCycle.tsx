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
import { ArrowLeft, ArrowRight, Bug, ChevronDown, ChevronUp, ExternalLink, GitBranch, Plus, RefreshCw, Search, Sparkles, TriangleAlert, X, Zap } from "./icons";
import {
  ago, cycleApi, flowApi, PLATFORM_WORD, type Compiled, type Cycle, type CycleKind, type CycleTicket, type GithubIssue, type Inventory, type Platform,
} from "./flowApi";
import { flowHref } from "./Board";
import { Figure, Thread } from "./kit";
import { guessRoles } from "./ReleaseHome";
import { Intake } from "./Intake";
import { Picker, type PickOption } from "./Picker";

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

const bump = (v: string) => { const parts = v.split("."); const last = Number(parts[parts.length - 1]); return Number.isFinite(last) ? [...parts.slice(0, -1), String(last + 1)].join(".") : v; };
const versionOfTag = (tag?: string | null) => tag?.match(/(\d+\.\d+\.\d+)/)?.[1] ?? null;

interface Suggestion { version: string; base: string; why: string; tags: { tag: string; platform: Platform; version?: string; build?: number; date?: string }[] }

/** What to open next: a planned release after the last one, or a hotfix on top of what's live. */
function useSuggestion(cid: string, actor: string | null, kind: CycleKind, fromCycles: string | null) {
  const [inv, setInv] = useState<Inventory | null>(null);
  const [reading, setReading] = useState(true);
  useEffect(() => {
    // Reading the inventory needs to know who's asking: wait for that, then read (cached for 2 minutes).
    if (!actor) return;
    const ctrl = new AbortController();
    setReading(true);
    flowApi.inventory(cid, "mobile_app_release", actor, false, ctrl.signal)
      .then(setInv).catch(() => undefined).finally(() => { if (!ctrl.signal.aborted) setReading(false); });
    return () => ctrl.abort();
  }, [cid, actor]);
  const tags = ALL.flatMap((p) => { const r = inv?.data.platforms?.[p]?.last_release; return r?.tag ? [{ tag: r.tag, platform: p, version: r.version, build: r.build, date: r.date }] : []; });
  let s: Suggestion | null = null;
  if (kind === "release") {
    const v = fromCycles ?? (typeof inv?.data.release_params?.version === "string" ? inv.data.release_params.version : null);
    if (v) s = { version: v, base: "main", tags, why: fromCycles ? "The version after the last release cycle." : "The next version after what's released, from the release inventory." };
  } else {
    // A hotfix goes on top of what's live: the newest store release tag, one patch up.
    const store = tags.filter((t) => t.platform === "ios" || t.platform === "android").map((t) => ({ ...t, v: versionOfTag(t.tag) })).filter((t) => t.v);
    const top = store.find((t) => t.platform === "ios") ?? store[0];
    if (top?.v) s = { version: bump(top.v), base: top.tag, tags, why: `One patch up from ${top.tag}, what's live.` };
    else if (tags[0]) s = { version: "", base: tags[0].tag, tags, why: "Cut from the last release tag." };
  }
  return { suggestion: s, reading };
}

function OpenCycle({ cid, actor, suggested, startKind, openRelease, onOpened }: {
  cid: string; actor: string | null; suggested: string | null; startKind: CycleKind; openRelease: { version: string; branch: string } | null; onOpened: (c: Cycle) => void;
}) {
  const people = usePeople(cid, actor);
  const ai = people.filter((p) => p.kind === "ai");
  const [kind, setKind] = useState<CycleKind>(startKind);
  const { suggestion, reading } = useSuggestion(cid, actor, kind, suggested);
  // Suggested values fill the fields; whatever you type wins and stops following them.
  const [typed, setTyped] = useState<Record<string, string>>({});
  const v = (typed.version ?? suggestion?.version ?? "").trim();
  const branch = typed.branch ?? (v ? `${kind}/${v}` : "");
  const base = typed.base ?? (kind === "hotfix" ? suggestion?.base ?? "" : "main");
  const milestone = typed.milestone ?? v;
  const set = (k: string) => (x: string) => setTyped((t) => ({ ...t, [k]: x }));
  const [platforms, setPlatforms] = useState<Platform[]>(ALL);
  const [roles, setRoles] = useState<Record<string, string | null>>({});
  const [engineers, setEngineers] = useState<Record<string, string | null>>({});
  const [perPlatform, setPerPlatform] = useState(false);
  const [makeBranch, setMakeBranch] = useState(true);
  const [dryRun, setDryRun] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!people.length) return;
    const g = guessRoles(people, actor);
    setRoles((r) => (Object.keys(r).length ? r : { engineer: g.engineer, release: g.release, qa: g.qa }));
    const by = (re: RegExp) => ai.find((a) => re.test(a.alias))?.id ?? null;
    setEngineers((e) => (Object.keys(e).length ? e : { ios: by(/ios|iphone/i), android: by(/android/i), web: by(/\bweb|front/i), api: by(/\bapi|back/i) }));
  }, [people.length]);
  useEffect(() => { setTyped((t) => ({ ...(t.version ? { version: t.version } : {}) })); }, [kind]);

  const collides = kind === "hotfix" && openRelease && openRelease.version === v;
  async function open() {
    setBusy(true); setError("");
    try {
      onOpened(await cycleApi.open(cid, actor, {
        kind, version: v, branch, base_branch: base.trim() || "main", milestone: milestone.trim() || undefined, platforms,
        roles, engineers: perPlatform ? engineers : {}, create_branch: makeBranch, dry_run: dryRun,
      }));
    } catch (e) { setError((e as Error).message); setBusy(false); }
  }
  const why = !v ? (reading ? "Reading the next version…" : "Choose the version.") : !base.trim() ? "Choose what to cut it from." : !platforms.length ? "Choose at least one platform." : !roles.engineer && !dryRun ? "Choose who builds the tickets." : "";
  const word = kind === "hotfix" ? "hotfix" : "release";
  const agents = (empty: string): PickOption[] => [{ value: "", label: empty }, ...ai.map((x) => ({ value: x.id, label: x.alias, hint: "Agent in this project" }))];
  const tagOptions: PickOption[] = [
    ...(suggestion?.tags ?? []).map((t) => ({
      value: t.tag, label: t.tag, mono: true, badge: PLATFORM_WORD[t.platform],
      hint: [t.version ? `Version ${t.version}` : null, t.build ? `build ${t.build}` : null, t.date ? `released ${new Date(t.date).toLocaleDateString()}` : null].filter(Boolean).join(" · ") || "The last release tag",
    })),
    ...(base && !(suggestion?.tags ?? []).some((t) => t.tag === base) ? [{ value: base, label: base, mono: true, hint: "Typed in" }] : []),
  ];
  return (
    <div className="fl-wrap fl-cy fl-cy-new">
      <header className="fl-head">
        <div>
          <h1 className="fl-h1">{kind === "hotfix" ? "Start a hotfix" : "Open a release cycle"}</h1>
          <p className="fl-sub">{kind === "hotfix" ? "A quick fix on top of what's live, without the work planned for the next release." : "Tickets collect on one release branch for the next two or three weeks. What you merge into it ships."}</p>
        </div>
        <div className="fl-head-actions"><Link className="fl-btn" data-variant="ghost" to={flowHref("/workflows", cid)}><ArrowLeft size={14} />Workflows</Link></div>
      </header>

      <div className="fl-cy-kinds" role="radiogroup" aria-label="What kind of release">
        {([["release", GitBranch, "Planned release", "Fixes and features over the next weeks, cut from main."], ["hotfix", Zap, "Hotfix", "One urgent fix to what's live, cut from its release tag."]] as const).map(([k, Icon, title, text]) => (
          <button key={k} type="button" role="radio" aria-checked={kind === k} className="fl-cy-kind" onClick={() => setKind(k)} data-kind={k}>
            <span className="fl-cy-kind-icon"><Icon size={18} /></span>
            <span><b>{title}</b><small>{text}</small></span>
          </button>
        ))}
      </div>

      <section className="fl-panel fl-cy-section" aria-label="Version and branch">
        <h2 className="fl-cy-section-title">Version and branch</h2>
        <div className="fl-cy-pair">
          <div className="fl-field">
            <label htmlFor="cy-version">Version {reading && !v ? <span className="fl-cy-reading"><RefreshCw size={11} className="fl-spinning" />Reading…</span> : null}</label>
            <input id="cy-version" className="fl-input fl-mono fl-cy-big" value={typed.version ?? suggestion?.version ?? ""} placeholder="1.0.3" onChange={(e) => set("version")(e.target.value)} />
            <span className="fl-help">{typed.version !== undefined && suggestion?.version && typed.version !== suggestion.version
              ? <>Suggested <button type="button" className="fl-linkbtn" onClick={() => setTyped((t) => { const { version: _v, ...rest } = t; return rest; })}>{suggestion.version}</button></>
              : suggestion?.why ?? (reading ? "" : "No earlier release to go from: type it.")}</span>
          </div>
          <div className="fl-field">
            <label htmlFor="cy-branch">Branch</label>
            <input id="cy-branch" className="fl-input fl-mono" value={branch} onChange={(e) => set("branch")(e.target.value)} />
            <span className="fl-help">{makeBranch && !dryRun ? "Created on GitHub when you open it." : "Not created: you make it, or it's a dry run."}</span>
          </div>
          {kind === "hotfix" ? (
            <Picker id="cy-base" label="Cut from" value={base} onChange={set("base")} options={tagOptions} icon={<GitBranch size={13} />}
              placeholder={reading ? "Reading the release tags…" : "No release tags found"}
              help="The release tag of what's live. Its fix merges back into main and the planned release." />
          ) : (
            <div className="fl-field">
              <label htmlFor="cy-base">Cut from</label>
              <input id="cy-base" className="fl-input fl-mono" value={base} onChange={(e) => set("base")(e.target.value)} />
            </div>
          )}
          <div className="fl-field">
            <label htmlFor="cy-milestone">GitHub milestone</label>
            <input id="cy-milestone" className="fl-input" value={milestone} onChange={(e) => set("milestone")(e.target.value)} />
            <span className="fl-help">Its open issues can be added as tickets.</span>
          </div>
        </div>
        {collides ? <p className="fl-cy-note"><TriangleAlert size={13} />Release {openRelease!.version} moves to {bump(openRelease!.version)}, and GitHub renames <span className="fl-mono">{openRelease!.branch}</span>; its open PRs follow.</p> : null}
      </section>

      <section className="fl-panel fl-cy-section" aria-label="Platforms">
        <h2 className="fl-cy-section-title">{kind === "hotfix" ? "Fix what's live on" : "Platforms this project ships"}</h2>
        <PlatformToggles value={platforms} onChange={setPlatforms} label="Platforms" />
      </section>

      <section className="fl-panel fl-cy-section" aria-label="Who works on the tickets">
        <h2 className="fl-cy-section-title">Who works on the tickets</h2>
        <div className="fl-cy-trio">
          <Picker id="cy-engineer" label="Engineer" value={roles.engineer ?? ""} onChange={(x) => setRoles({ ...roles, engineer: x || null })} options={agents("Nobody yet")} help="Builds each ticket." />
          <Picker id="cy-release" label="Release" value={roles.release ?? ""} onChange={(x) => setRoles({ ...roles, release: x || null })} options={agents("Nobody yet")} help="Deploys to staging, builds the release." />
          <Picker id="cy-qa" label="QA" value={roles.qa ?? ""} onChange={(x) => setRoles({ ...roles, qa: x || null })} options={agents("Nobody yet")} help="Checks each ticket on its platforms." />
        </div>
        <button type="button" className="fl-cy-disclose" aria-expanded={perPlatform} onClick={() => setPerPlatform((x) => !x)}>
          {perPlatform ? <ChevronUp size={14} /> : <ChevronDown size={14} />}A different engineer per platform
        </button>
        {perPlatform ? (
          <div className="fl-cy-trio">
            {platforms.map((p) => <Picker key={p} id={`cy-eng-${p}`} label={`${PLATFORM_WORD[p]} only`} value={engineers[p] ?? ""} onChange={(x) => setEngineers({ ...engineers, [p]: x || null })} options={agents("Same engineer")} />)}
          </div>
        ) : null}
      </section>

      <div className="fl-startbar fl-rh-start" role="region" aria-label="Open the cycle">
        <div className="fl-rh-start-main">
          <span className="fl-rh-label">{v ? <>{kind === "hotfix" ? "Hotfix" : "Release"} <b className="fl-mono">{v}</b> on <span className="fl-mono">{branch}</span> from <span className="fl-mono">{base || "…"}</span></> : `Open a ${word}`}</span>
          {!dryRun ? (
            <label className="fl-cy-check"><input type="checkbox" checked={makeBranch} onChange={(e) => setMakeBranch(e.target.checked)} />Create the branch on GitHub</label>
          ) : <span className="fl-help">Dry run: no branch, and no agent wakes. Your steps still wait for you.</span>}
          {why ? <span className="fl-help" aria-live="polite">{why}</span> : null}
          {error ? <span className="fl-problem" role="alert"><TriangleAlert size={13} />{error}</span> : null}
        </div>
        <div className="fl-head-actions">
          <label style={{ display: "inline-flex", gap: 8, alignItems: "center", fontSize: 13, color: "var(--v2-text-2)" }}>
            <button type="button" role="switch" className="fl-switch" aria-checked={dryRun} onClick={() => setDryRun((d) => !d)} aria-label="Dry run" />Dry run
          </label>
          <button type="button" className="fl-btn" data-variant="primary" data-size="lg" disabled={!!why || busy} onClick={open} data-open-cycle>
            {kind === "hotfix" ? <Zap size={15} /> : <GitBranch size={15} />}{busy ? "Opening…" : kind === "hotfix" ? "Start the hotfix" : "Open the cycle"}
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
          <span className="fl-help">Read through this project's GitHub connection (the GitHub tab). Nothing on GitHub changes.</span>
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

/* ---- the board --------------------------------------------------------------------- */

const COLUMNS: { phase: CycleTicket["phase"]; title: string; hint: string }[] = [
  { phase: "spec", title: "Spec", hint: "A feature's spec, written and approved" },
  { phase: "build", title: "Building", hint: "Test-first, a PR into the branch" },
  { phase: "review", title: "Waiting for your merge", hint: "Your merge is your decision it ships" },
  { phase: "checking", title: "In the branch", hint: "Merged; being checked on staging" },
  { phase: "ready", title: "Ready to ship", hint: "Merged and checked on staging" },
  { phase: "shipped", title: "Shipped", hint: "Went out with the cut" },
];

function BoardCard({ t, cid, dry }: { t: CycleTicket; cid: string; dry: boolean }) {
  const navigate = useNavigate();
  const Kind = t.kind === "feature" ? Sparkles : Bug;
  const open = () => t.workflow_id && navigate(flowHref(`/workflows/${encodeURIComponent(t.workflow_id)}`, cid));
  return (
    <li className="fl-kb-card" role="link" tabIndex={0} onClick={open} onKeyDown={(e) => { if (e.key === "Enter") open(); }}
      data-needs-you={t.needs_you || undefined} data-ticket={t.id} aria-label={`${t.issue_number ? `#${t.issue_number} ` : ""}${t.title}: ${t.word}`}>
      <span className="fl-kb-top">
        <Kind size={13} aria-hidden="true" data-kind={t.kind} />
        {t.issue_number ? <span className="fl-mono fl-kb-ref">#{t.issue_number}</span> : <span className="fl-kb-ref fl-muted">No issue</span>}
        {t.rolled_from_cycle_id ? <span className="fl-kb-tag">Rolled over</span> : null}
        {t.issue_url ? <a className="fl-kb-gh" href={t.issue_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} aria-label={`Open #${t.issue_number ?? ""} on GitHub`} title="Open on GitHub"><ExternalLink size={12} /></a> : null}
      </span>
      <span className="fl-kb-title">{t.title}</span>
      <span className="fl-kb-plats">{t.platforms.map((p) => <span key={p} className="fl-kb-plat">{PLATFORM_WORD[p]}</span>)}</span>
      <Thread dots={t.thread} label={`${t.done} of ${t.total} steps done`} />
      <span className="fl-kb-foot">
        {t.engineer ? <span className="fl-kb-who" title={`Built by ${t.engineer}`}><i>{t.engineer.slice(0, 1).toUpperCase()}</i>{t.engineer}</span> : <span className="fl-muted">{dry ? "Dry run" : "Unassigned"}</span>}
        {t.needs_you ? <span className="fl-kb-you" title={t.word}>Needs you</span> : t.phase === "checking" || t.phase === "build" ? <span className="fl-kb-step" title={t.word}>{t.word}</span> : null}
      </span>
    </li>
  );
}

function CycleBoard({ tickets, cid, cut, dry }: { tickets: CycleTicket[]; cid: string; cut: boolean; dry: boolean }) {
  const cols = COLUMNS.filter((c) => c.phase !== "shipped" || cut || tickets.some((t) => t.phase === "shipped"));
  return (
    <div className="fl-kb" role="list" aria-label="Tickets by stage">
      {cols.map((c) => {
        const here = tickets.filter((t) => t.phase === c.phase);
        return (
          <section key={c.phase} className="fl-kb-col" data-phase={c.phase} aria-label={c.title} role="listitem">
            <header><b>{c.title}</b><span className="fl-mono">{here.length}</span></header>
            <p className="fl-kb-hint">{c.hint}</p>
            <ul>{here.map((t) => <BoardCard key={t.id} t={t} cid={cid} dry={dry} />)}</ul>
            {!here.length ? <p className="fl-kb-empty">Nothing here</p> : null}
          </section>
        );
      })}
    </div>
  );
}

function useView(): ["board" | "list", (v: "board" | "list") => void] {
  const [v, setV] = useState<"board" | "list">(() => { try { return (localStorage.getItem("fl-cy-view") as "board" | "list") || "board"; } catch { return "board"; } });
  return [v, (x) => { setV(x); try { localStorage.setItem("fl-cy-view", x); } catch { /* private window */ } }];
}

function CycleView({ cycle, cid, actor, setCycle, startWith }: { cycle: Cycle; cid: string; actor: string | null; setCycle: (c: Cycle) => void; startWith?: "intake" | "" }) {
  const navigate = useNavigate();
  const people = usePeople(cid, actor);
  const [panel, setPanel] = useState<"" | "add" | "github" | "intake">(startWith ?? "");
  const [filter, setFilter] = useState<Platform | "all">("all");
  const [view, setView] = useView();
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
          <h1 className="fl-h1">{cycle.kind === "hotfix" ? <><Zap size={20} aria-hidden="true" />Hotfix</> : "Release"} {cycle.version} {cycle.dry_run ? <span className="fl-chip" data-tone="info">Dry run</span> : null}
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
            {cycle.kind === "release" ? <Link className="fl-btn" data-variant="ghost" to={flowHref("/workflows/cycle", cid, { kind: "hotfix" })} data-hotfix><Zap size={14} />Hotfix</Link> : null}
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
        <div className="fl-cy-bar-row">
        <div className="fl-toggles" role="radiogroup" aria-label="Show tickets for">
          {(["all", ...cycle.platforms] as const).map((p) => (
            <button key={p} type="button" role="radio" className="fl-toggle" aria-checked={filter === p} aria-pressed={filter === p} onClick={() => setFilter(p)}>
              {p === "all" ? "All" : PLATFORM_WORD[p]}
            </button>
          ))}
        </div>
        <div className="fl-cy-seg" role="radiogroup" aria-label="View">
          {(["board", "list"] as const).map((x) => <button key={x} type="button" role="radio" aria-checked={view === x} onClick={() => setView(x)}>{x === "board" ? "Board" : "List"}</button>)}
        </div>
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

      {view === "board" && (cycle.tickets ?? []).length ? <CycleBoard tickets={live} cid={cid} cut={!open} dry={cycle.dry_run} /> : null}
      {view === "list" ? <>
      <Group title="Waiting for you" count={needs.length}>{needs.map((t, i) => <TicketRow key={t.id} t={t} i={i} cycle={cycle} cid={cid} actor={actor} onChanged={setCycle} />)}</Group>
      <Group title="Being built" count={going.length}>{going.map((t, i) => <TicketRow key={t.id} t={t} i={i} cycle={cycle} cid={cid} actor={actor} onChanged={setCycle} />)}</Group>
      <Group title={open ? "In the branch" : "Shipped"} count={inBranch.length}>{inBranch.map((t, i) => <TicketRow key={t.id} t={t} i={i} cycle={cycle} cid={cid} actor={actor} onChanged={setCycle} />)}</Group>
      <Group title="Taken out" count={out.length}>{out.map((t, i) => <TicketRow key={t.id} t={t} i={i} cycle={cycle} cid={cid} actor={actor} onChanged={setCycle} />)}</Group>
      </> : null}

      {open ? (
        <div className="fl-startbar fl-rh-start" role="region" aria-label="Cut the release">
          <div className="fl-rh-start-main">
            <span className="fl-rh-label">
              {ships ? <><b>{ships}</b> {ships === 1 ? "ticket ships" : "tickets ship"}{cycle.cut.platforms.length ? <> on {cycle.cut.platforms.map((p) => PLATFORM_WORD[p]).join(", ")}</> : null}</> : "Nothing is merged into the branch yet"}
              {rolls ? <> · {rolls} {rolls === 1 ? "moves" : "move"} to {cycle.kind === "hotfix" ? "release " : ""}<span className="fl-mono">{cycle.cut.next_version}</span></> : null}
            </span>
            <span className="fl-help">
              {unchecked ? `${unchecked} merged ${unchecked === 1 ? "ticket hasn't" : "tickets haven't"} passed its staging check yet; the full regression still covers it. ` : ""}
              The cut starts the release from <span className="fl-mono">{cycle.branch}</span>{cycle.kind === "hotfix"
                ? <>; after it ships the fix merges back into main and <span className="fl-mono">{cycle.cut.next_branch}</span>.</>
                : <> and opens <span className="fl-mono">{cycle.cut.next_branch}</span> for what's left.</>}
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
  const kind: CycleKind = params.get("kind") === "hotfix" ? "hotfix" : "release";
  const [cycle, setCycle] = useState<Cycle | null>(null);
  const [suggested, setSuggested] = useState<string | null | undefined>(undefined);
  const [openRelease, setOpenRelease] = useState<{ version: string; branch: string } | null>(null);
  const [error, setError] = useState("");
  const seq = useRef(0);

  useEffect(() => {
    if (!cid || id) return;
    const ctrl = new AbortController();
    cycleApi.list(cid, actor, ctrl.signal).then((l) => {
      const open = fresh ? null : kind === "hotfix" ? l.open_hotfix ?? l.open_hotfix_dry_run : l.open ?? l.open_dry_run;
      const planned = l.cycles.find((c) => c.id === (l.open ?? l.open_dry_run));
      setOpenRelease(planned ? { version: planned.version, branch: planned.branch } : null);
      if (open) navigate(flowHref("/workflows/cycle", cid, { cycle: open, ...(intake ? { intake: "1" } : {}) }), { replace: true });
      else setSuggested(l.suggested.version);
    }).catch((e: Error) => { if (e.name !== "AbortError") setError(e.message); });
    return () => ctrl.abort();
  }, [cid, id, fresh, kind]);

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
    return <OpenCycle key={kind} cid={cid} actor={actor} suggested={suggested} startKind={kind} openRelease={openRelease} onOpened={(c) => navigate(flowHref("/workflows/cycle", cid, { cycle: c.id }))} />;
  }
  if (!cycle) return <div className="fl-wrap"><p className="fl-muted" aria-busy="true">Loading the release cycle…</p></div>;
  return <CycleView cycle={cycle} cid={cid} actor={actor} setCycle={setCycle} startWith={intake && cycle.state === "open" ? "intake" : ""} />;
}
