/** The template gallery: each card plays its flow once on hover (Verdikt's TemplateCard + MiniFlow). */
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { FileUp, Layers, Plus, Rocket, Shuffle, Workflow } from "./icons";
import type { TemplateSummary } from "./flowApi";
import { KindGlyph } from "./kit";
import { useReducedMotion } from "./motion";

const ICON: Record<string, typeof Rocket> = { rocket: Rocket, loop: Shuffle, workflows: Workflow };

function MiniFlow({ t, playing }: { t: TemplateSummary; playing: boolean }) {
  const reduced = useReducedMotion();
  // One node a stage: the stage's most telling step (a gate, else something leaving, else the first).
  const stages = useMemo(() => {
    const out: { key: string; kind: TemplateSummary["thread"][number]["kind"]; outward: boolean }[] = [];
    for (const d of t.thread) {
      const at = out.find((s) => s.key === d.stage);
      if (!at) out.push({ key: d.stage ?? String(out.length), kind: d.kind, outward: d.outward });
      else if (d.kind === "gate" || (d.outward && at.kind !== "gate")) Object.assign(at, { kind: d.kind, outward: d.outward });
    }
    return out;
  }, [t]);
  const beats = useMemo(() => stages.map((_s, i) => 380 * i + (i && stages[i - 1].kind === "gate" ? 600 : 0) + i * 20), [stages]);
  const [p, setP] = useState(-1);
  useEffect(() => {
    if (!playing || reduced) { setP(-1); return; }
    const timers = [...beats, beats.at(-1)! + 600].map((b, i) => setTimeout(() => setP(i), b));
    return () => timers.forEach(clearTimeout);
  }, [playing, reduced, beats]);
  const at = playing && !reduced ? p : -1;
  const words = at >= 0 && at < stages.length
    ? `${at + 1}. ${stages[at].kind === "gate" ? "waits for your go" : stages[at].outward ? "leaves Embodent" : stages[at].kind === "watch" ? "watches the store" : stages[at].kind === "qa" ? "QA checks" : stages[at].kind === "person" ? "you decide" : "an agent works"}`
    : at >= stages.length ? "Lands, with its proof"
    : `${t.step_count} steps · ${t.outward} leave Embodent · ${t.gates} ${t.gates === 1 ? "gate" : "gates"}`;
  return (
    <div>
      <div className="fl-mini" aria-hidden="true">
        {stages.map((s, i) => (
          <Fragment key={s.key}>
            {i ? <span className="fl-mini-wire" data-filled={at >= i}><i /></span> : null}
            <span className="fl-mini-node" data-kind={s.kind} data-out={s.outward} data-state={at > i ? "done" : at === i ? "on" : "idle"} />
          </Fragment>
        ))}
      </div>
      <p key={at} className="fl-caption">{words}</p>
    </div>
  );
}

export function TemplateCard({ t, i, featured, onPick }: { t: TemplateSummary; i: number; featured?: boolean; onPick: () => void }) {
  const [looked, setLooked] = useState(false);
  const Icon = ICON[t.icon] ?? Layers;
  return (
    <button type="button" className="fl-tcard" data-tone={t.tone} data-featured={featured} style={{ ["--i" as string]: i }}
      onMouseEnter={() => setLooked(true)} onMouseLeave={() => setLooked(false)} onFocus={() => setLooked(true)} onBlur={() => setLooked(false)}
      onClick={onPick} aria-label={`${t.name}: ${t.description}`} data-template={t.key}>
      <span className="fl-tcard-top">
        <span className="fl-ticon"><Icon size={20} /></span>
        <span style={{ minWidth: 0 }}>
          <span className="fl-tname">{t.name}</span>
          <span className="fl-tdesc" style={{ display: "block" }}>{t.description}</span>
        </span>
      </span>
      <MiniFlow t={t} playing={looked} />
      <span className="fl-tfacts">
        <span className="fl-chip" data-tone="muted">{t.stage_count} stages</span>
        <span className="fl-chip" data-tone="muted">{t.step_count} steps</span>
        {t.gates ? <span className="fl-chip" data-kind="gate"><KindGlyph kind="gate" size={12} />{t.gates} required {t.gates === 1 ? "gate" : "gates"}</span> : null}
        {t.watches ? <span className="fl-chip" data-kind="watch"><KindGlyph kind="watch" size={12} />{t.watches} watched</span> : null}
        {t.source === "project" ? <span className="fl-chip" data-tone="info">This project's copy{t.update_available ? " · update available" : ""}</span> : null}
      </span>
    </button>
  );
}

export function Gallery({ templates, onPick, onBlank, onImport }: { templates: TemplateSummary[]; onPick: (key: string) => void; onBlank: () => void; onImport: (json: unknown) => void }) {
  const file = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState("");
  const featured = templates.find((t) => t.key === "mobile_app_release");
  const rest = templates.filter((t) => t !== featured);
  return (
    <div className="fl-gallery" role="list" aria-label="Templates">
      {featured ? <TemplateCard t={featured} i={0} featured onPick={() => onPick(featured.key)} /> : null}
      {rest.map((t, i) => <TemplateCard key={t.key} t={t} i={i + 1} onPick={() => onPick(t.key)} />)}
      <button type="button" className="fl-tcard" data-tone="indigo" style={{ ["--i" as string]: rest.length + 1 }} onClick={onBlank}>
        <span className="fl-tcard-top"><span className="fl-ticon"><Plus size={20} /></span>
          <span><span className="fl-tname">Blank workflow</span><span className="fl-tdesc" style={{ display: "block" }}>Start from nothing and add steps one by one.</span></span></span>
      </button>
      <button type="button" className="fl-tcard" data-tone="indigo" style={{ ["--i" as string]: rest.length + 2 }} onClick={() => file.current?.click()}>
        <span className="fl-tcard-top"><span className="fl-ticon"><FileUp size={20} /></span>
          <span><span className="fl-tname">Import a template</span><span className="fl-tdesc" style={{ display: "block" }}>A template JSON exported from another project or kept in a repo.</span></span></span>
        {err ? <span className="fl-problem" role="alert">{err}</span> : null}
      </button>
      <input ref={file} type="file" accept="application/json,.json" hidden onChange={async (e) => {
        const f = e.target.files?.[0];
        e.target.value = "";
        if (!f) return;
        try { setErr(""); onImport(JSON.parse(await f.text())); } catch { setErr("That file isn't a template JSON."); }
      }} />
    </div>
  );
}
