/**
 * The Release home: before a release starts, what the project's own inventory script says. Per
 * platform: what's live, what's in review, the last release, the PRs merged since and the next
 * version and build. Then the open PRs, and one Start that pre-fills everything from
 * `release_params`, so nobody types a version or a build number. Only the iOS release type is
 * asked, because Apple asks it every version. The same live check as the editor gates Start;
 * "Customize steps" opens the editor with these values.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useActingAuthority, useSnapshot } from "../../state/SnapshotProvider";
import { ArrowLeft, ArrowUpRight, ExternalLink, GitBranch, Play, RefreshCw, Settings2, TriangleAlert } from "./icons";
import { flowApi, PLATFORM_WORD, watchWord, type Compiled, type Inventory, type InventoryPlatform, type Platform } from "./flowApi";
import { flowHref } from "./Board";
import { useDebounced } from "./motion";

const ORDER: Platform[] = ["ios", "android", "web", "api"];

function ago(iso?: string | null): string {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

function liveWords(p: Platform, e: InventoryPlatform): string {
  const live = e.live;
  if (!live) return p === "api" ? "Not read" : "Couldn't read";
  if (live.version) return live.version;
  const id = Array.isArray(live.build_id) ? live.build_id.join(", ") : live.build_id;
  return id ? `build ${String(id).slice(0, 10)}` : "Couldn't read";
}

/** Guess who does what from agent names, so the common case needs no choosing. */
function guessRoles(people: Compiled["people"], me: string | null): Record<string, string | null> {
  const ai = people.filter((p) => p.kind === "ai");
  const find = (re: RegExp, not?: RegExp) => ai.find((a) => re.test(`${a.alias} ${a.role ?? ""}`) && !(not && not.test(a.alias)))?.id ?? null;
  return {
    owner: me,
    release: find(/release/i),
    qa: find(/\bqa|quality/i),
    engineer: find(/engineer|dev|mobile|ios|android|web/i, /release|qa/i),
  };
}

function PlatformCard({ p, e, picked, i }: { p: Platform; e: InventoryPlatform; picked: boolean; i: number }) {
  const store = p === "ios" || p === "android";
  const review = e.in_flight?.state;
  const n = e.changes.length;
  return (
    <article className="fl-rh-card" data-platform={p} data-picked={picked} style={{ ["--i" as string]: i }} aria-label={PLATFORM_WORD[p]}>
      <header className="fl-rh-card-head">
        <b>{PLATFORM_WORD[p]}</b>
        <span className="fl-chip" data-tone={picked ? "accent" : "muted"}>{picked ? "In this release" : n ? `${n} changes` : "No changes"}</span>
      </header>
      <dl className="fl-rh-facts">
        <div><dt>Live</dt><dd className="fl-mono">{liveWords(p, e)}{e.live?.since ? <small> · since {new Date(e.live.since).toLocaleDateString()}</small> : null}</dd></div>
        {store ? <div><dt>In review</dt><dd>{review ? <span className="fl-chip" data-tone={review === "rejected" ? "danger" : review === "error" ? "warn" : review.includes("ready") || review === "live" ? "ok" : "info"}>{watchWord(review)}</span> : <span className="fl-muted">Nothing</span>}</dd></div> : null}
        <div><dt>Last release</dt><dd className="fl-mono">{e.last_release?.tag ?? <span className="fl-muted">No tag yet</span>}</dd></div>
      </dl>
      {store ? (
        <div className="fl-rh-next">
          <span className="fl-label">Next</span>
          {e.next?.version ? <span className="fl-rh-version fl-mono">{e.next.version} <span>({e.next.build})</span></span> : <span className="fl-problem" data-tone="warn"><TriangleAlert size={12} />Unknown</span>}
          {e.next?.reason ? <small className="fl-help">{e.next.reason}</small> : null}
        </div>
      ) : null}
      <div className="fl-rh-changes">
        <span className="fl-label">Merged since {e.last_release?.tag ? "the last release" : "—"} <span className="fl-mono fl-muted">{n}</span></span>
        {n ? (
          <ul>
            {e.changes.slice(0, 6).map((c) => <li key={c.sha}>{c.pr ? <b className="fl-mono">#{c.pr}</b> : <span className="fl-mono fl-muted">{c.sha.slice(0, 7)}</span>}<span>{c.title}</span></li>)}
            {n > 6 ? <li className="fl-muted">and {n - 6} more</li> : null}
          </ul>
        ) : <p className="fl-muted">Nothing new.</p>}
      </div>
    </article>
  );
}

export function ReleaseHome() {
  const { cid } = useSnapshot();
  const authority = useActingAuthority();
  const actor = authority.human?.id ?? null;
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const key = params.get("template") ?? "mobile_app_release";
  const [inv, setInv] = useState<Inventory | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [releaseType, setReleaseType] = useState<string>("");
  const [dryRun, setDryRun] = useState(false);
  const [roles, setRoles] = useState<Record<string, string | null> | null>(null);
  const [compiled, setCompiled] = useState<Compiled | null>(null);
  const [checking, setChecking] = useState(false);
  const [starting, setStarting] = useState(false);
  const seq = useRef(0);

  function read(refresh: boolean) {
    if (!cid) return;
    setLoading(true); setError("");
    flowApi.inventory(cid, key, actor, refresh).then(setInv).catch((e: Error) => setError(e.message)).finally(() => setLoading(false));
  }
  useEffect(() => { read(false); }, [cid, key, actor]);

  const rp = inv?.data.release_params ?? {};
  const platforms = (rp.platforms ?? []) as Platform[];
  const values = useMemo(() => ({ ...rp, ...(releaseType ? { release_type: releaseType } : {}) }), [JSON.stringify(rp), releaseType]);
  const input = useMemo(() => ({ params: values, removed: [] as string[], added: [], roles: roles ?? {}, dry_run: dryRun }), [values, roles, dryRun]);
  const debounced = useDebounced(input, 400);

  useEffect(() => {
    if (!cid || !inv || inv.state === "error" || !platforms.length) return;
    const mine = ++seq.current;
    setChecking(true);
    flowApi.compile(cid, key, actor, debounced).then((c) => {
      if (mine !== seq.current) return;
      setCompiled(c);
      if (!roles) setRoles(guessRoles(c.people, actor));
    }).catch((e: Error) => { if (mine === seq.current) setError(e.message); }).finally(() => { if (mine === seq.current) setChecking(false); });
  }, [cid, key, actor, JSON.stringify(debounced), inv?.read_at]);

  if (!cid) return <div className="fl-wrap"><p className="fl-muted">Choose a project first.</p></div>;

  const ios = platforms.includes("ios");
  const problems = (compiled?.problems ?? []).filter((p) => p.param !== "release_type");
  const label = (compiled?.values?.release_label as string | undefined) ?? "";
  const ready = !!compiled && !checking && problems.length === 0 && (!ios || !!releaseType) && JSON.stringify(debounced) === JSON.stringify(input);
  const why = !inv ? "" : inv.state === "error" ? "The inventory couldn't be read."
    : !platforms.length ? "Nothing changed since the last release."
    : ios && !releaseType ? "Choose how iOS is released."
    : checking || !compiled ? "Checking…"
    : problems.length ? problems[0].message : "";
  const people = compiled?.people ?? [];
  const aiRoles = (compiled?.roles ?? []).filter((r) => r.kind === "ai");

  async function start() {
    if (!ready || !cid) return;
    setStarting(true); setError("");
    try {
      const d = await flowApi.create(cid, actor, { key, ...input, start: true });
      navigate(flowHref(`/workflows/${encodeURIComponent(d.id)}`, cid), { state: { justStarted: true } });
    } catch (e) { setError((e as Error).message); setStarting(false); }
  }

  const prs = inv?.data.open_prs ?? [];
  const warnings = inv?.data.warnings ?? [];
  return (
    <div className="fl-wrap fl-rh">
      <header className="fl-head">
        <div>
          <h1 className="fl-h1">Release home</h1>
          <p className="fl-sub">{inv?.summary ?? "Reading what's live, in review and merged…"}</p>
        </div>
        <div className="fl-head-actions">
          <Link className="fl-btn" data-variant="ghost" to={flowHref("/workflows/new", cid)}><ArrowLeft size={14} />Templates</Link>
          <button type="button" className="fl-btn" onClick={() => read(true)} disabled={loading} data-refresh>
            <RefreshCw size={14} className={loading ? "fl-spinning" : undefined} />{loading ? "Reading…" : `Read again${inv ? ` · ${ago(inv.read_at)}` : ""}`}
          </button>
        </div>
      </header>

      {error ? <p className="fl-problem" role="alert"><TriangleAlert size={13} />{error}</p> : null}
      {inv?.state === "error" ? (
        <section className="fl-panel" role="alert">
          <h2 className="fl-h2">Couldn't read the release inventory</h2>
          <p className="fl-muted">{inv.summary}{inv.error ? `: ${inv.error}` : ""}</p>
          <p className="fl-help">It runs <code className="fl-mono">{inv.command}</code> from the project root. Change it in the template's advanced parameters, or customize the release by hand.</p>
        </section>
      ) : null}
      {warnings.length ? (
        <details className="fl-rh-warn">
          <summary><TriangleAlert size={13} />{warnings.length} {warnings.length === 1 ? "source" : "sources"} couldn't be read; the rest is current</summary>
          <ul>{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </details>
      ) : null}

      {!inv && loading ? <div className="fl-rh-grid" aria-busy="true">{ORDER.map((p) => <div key={p} className="fl-rh-card fl-rh-skeleton" />)}</div> : null}
      {inv && inv.state !== "error" ? (
        <div className="fl-rh-grid">
          {ORDER.filter((p) => inv.data.platforms?.[p]).map((p, i) => <PlatformCard key={p} p={p} e={inv.data.platforms![p]!} picked={platforms.includes(p)} i={i} />)}
        </div>
      ) : null}

      {inv && inv.state !== "error" ? (
        <section className="fl-panel fl-rh-prs" aria-labelledby="fl-rh-prs">
          <h2 id="fl-rh-prs" className="fl-h2"><GitBranch size={14} /> Open PRs <span className="fl-mono fl-muted">{prs.length}</span></h2>
          {prs.length ? (
            <ul>
              {prs.map((pr) => (
                <li key={pr.number}>
                  <a href={pr.url} target="_blank" rel="noreferrer"><b className="fl-mono">#{pr.number}</b><span>{pr.title}</span><ExternalLink size={11} /></a>
                  <span className="fl-rh-tags">
                    {pr.draft ? <span className="fl-chip" data-tone="muted">Draft</span> : null}
                    {pr.platforms.map((x) => <span key={x} className="fl-chip" data-tone="muted">{PLATFORM_WORD[x]}</span>)}
                  </span>
                </li>
              ))}
            </ul>
          ) : <p className="fl-muted">No open PRs. Everything merged is in the lists above.</p>}
          <p className="fl-help">Open PRs aren't in this release. Merge them first if they should be.</p>
        </section>
      ) : null}

      {inv && inv.state !== "error" ? (
        <div className="fl-startbar fl-rh-start" role="region" aria-label="Start the release">
          <div className="fl-rh-start-main">
            <span className="fl-rh-label">{platforms.length ? <>Release <b className="fl-mono">{label || "…"}</b> on {platforms.map((p) => PLATFORM_WORD[p]).join(", ")}</> : "Nothing to release"}</span>
            {ios ? (
              <div className="fl-toggles" role="radiogroup" aria-label="How iOS is released">
                <button type="button" role="radio" className="fl-toggle" aria-checked={releaseType === "manual"} aria-pressed={releaseType === "manual"} onClick={() => setReleaseType("manual")} data-release-type="manual">I release it by hand</button>
                <button type="button" role="radio" className="fl-toggle" aria-checked={releaseType === "after_approval"} aria-pressed={releaseType === "after_approval"} onClick={() => setReleaseType("after_approval")} data-release-type="after_approval">Automatically after approval</button>
              </div>
            ) : null}
            {!dryRun && aiRoles.length && roles ? (
              <div className="fl-rh-roles">
                {aiRoles.map((r) => (
                  <label key={r.key} className="fl-cmp-pill" data-empty={!roles[r.key] || undefined}>
                    <span className="fl-muted">{r.label}</span>
                    <select aria-label={r.label} value={roles[r.key] ?? ""} onChange={(e) => setRoles({ ...roles, [r.key]: e.target.value || null })}>
                      <option value="">Choose…</option>
                      {people.filter((x) => x.kind === "ai").map((x) => <option key={x.id} value={x.id}>{x.alias}</option>)}
                    </select>
                  </label>
                ))}
              </div>
            ) : null}
            {why ? <span className="fl-help" aria-live="polite">{why}</span> : null}
          </div>
          <div className="fl-head-actions">
            <label style={{ display: "inline-flex", gap: 8, alignItems: "center", fontSize: 13, color: "var(--v2-text-2)" }}>
              <button type="button" role="switch" className="fl-switch" aria-checked={dryRun} onClick={() => setDryRun((d) => !d)} aria-label="Dry run" />Dry run
            </label>
            <button type="button" className="fl-btn" disabled={!platforms.length} data-customize
              onClick={() => navigate(flowHref("/workflows/new", cid, { template: key }), { state: { params: values, roles, dryRun } })}>
              <Settings2 size={14} />Customize steps
            </button>
            <button type="button" className="fl-btn" data-variant="primary" data-size="lg" disabled={!ready || starting} onClick={start} data-start>
              <Play size={15} />{starting ? "Starting…" : dryRun ? "Start the dry run" : "Start the release"}
            </button>
          </div>
        </div>
      ) : null}
      {inv && inv.state !== "error" && compiled ? (
        <p className="fl-help" style={{ textAlign: "center" }}>
          {compiled.steps.filter((s) => !s.removed).length} steps, with your go-ahead before anything reaches a store <ArrowUpRight size={11} />
        </p>
      ) : null}
    </div>
  );
}
