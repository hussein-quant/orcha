/**
 * The pieces every Workflows screen shares: step-kind glyphs and chips, state chips (always icon
 * plus word), the Orb, the stage circuit, count-up figures, the steps thread and the teaching scene.
 */
import { Fragment, type ReactNode } from "react";
import {
  ArrowUpRight, Bot, Check, CircleDashed, Eye, Flag, Hand, Hourglass, Lock, Pause, Radar, ScanEye, ShieldCheck, Square, UserRound, X, Zap,
  type LucideIcon,
} from "../qa/map/kit/icons";
import { KIND_WORD, STATE_WORD, type StepKind, type StepState, type ThreadDot } from "./flowApi";
import { usePlayhead, useTween } from "./motion";

export const KIND_ICON: Record<StepKind, LucideIcon> = { agent: Bot, person: UserRound, qa: ScanEye, watch: Radar, gate: ShieldCheck };

export function KindGlyph({ kind, size = 16 }: { kind: StepKind; size?: number }) {
  const Icon = KIND_ICON[kind] ?? Bot;
  return <Icon size={size} strokeWidth={1.9} aria-hidden="true" />;
}

export function KindChip({ kind, outward }: { kind: StepKind; outward?: string | null }) {
  return (
    <span className="fl-chip" data-kind={kind} data-out={outward ? "true" : undefined} title={outward ? `Leaves Embodent: ${outward}` : undefined}>
      <KindGlyph kind={kind} size={12} />
      {KIND_WORD[kind]}
      {outward ? <><ArrowUpRight size={11} strokeWidth={2.5} aria-hidden="true" />{outward}</> : null}
    </span>
  );
}

const STATE_ICON: Record<StepState, LucideIcon> = {
  waiting: CircleDashed, ready: Hourglass, running: Zap, review: Eye, asking: Hand, done: Check, failed: X, skipped: Square,
};
const STATE_TONE: Record<StepState, string> = {
  waiting: "muted", ready: "info", running: "accent", review: "info", asking: "warn", done: "ok", failed: "danger", skipped: "muted",
};

export function StateChip({ state, word }: { state: StepState; word?: string }) {
  const Icon = STATE_ICON[state];
  return <span className="fl-chip" data-tone={STATE_TONE[state]}><Icon size={12} strokeWidth={2.2} aria-hidden="true" />{word ?? STATE_WORD[state]}</span>;
}

export type OrbTone = "live" | "asking" | "good" | "bad" | "stopped" | "held";
const ORB_ICON: Record<Exclude<OrbTone, "live">, LucideIcon> = { asking: Hand, good: Check, bad: X, stopped: Square, held: Pause };
const R = 26;
const LEN = 2 * Math.PI * R;

/** Overall progress: spins while running, breathes while waiting on a person or a watch, bursts once on landing. */
export function Orb({ tone, fraction, landedAt, kind }: { tone: OrbTone; fraction: number; landedAt: number; kind?: StepKind | null }) {
  const over = tone === "good" || tone === "bad" || tone === "stopped";
  const Glyph = tone === "live" ? (kind ? KIND_ICON[kind] : Zap) : ORB_ICON[tone];
  return (
    <span className="fl-orb" aria-hidden="true" data-orb={tone}>
      <svg viewBox="0 0 60 60" width={60} height={60}>
        <circle className="fl-orb-track" cx={30} cy={30} r={R} />
        <circle className="fl-orb-value" cx={30} cy={30} r={R} strokeDasharray={LEN} strokeDashoffset={LEN * (1 - Math.max(0.02, Math.min(1, fraction)))} />
      </svg>
      {tone === "live" ? <span className="fl-orb-spin" /> : null}
      {tone === "asking" ? <span className="fl-orb-breathe" /> : null}
      {landedAt ? <span key={landedAt} className="fl-orb-burst" data-orb-burst /> : null}
      <span key={over ? `over-${tone}` : tone} className={`fl-orb-core${over && landedAt ? " fl-land-pop" : ""}`} data-landed={over}>
        <Glyph size={20} strokeWidth={tone === "live" ? 2 : 2.5} />
      </span>
    </span>
  );
}

export interface CircuitStage { key: string; title: string; state: StepState | "landed"; outward: boolean; count: string; kind?: StepKind }

/** The stages, left to right: a finished stage lights its wire; a pulse runs into the next when one lands while you watch. */
export function Circuit({ stages, pulse, asking }: { stages: CircuitStage[]; pulse: { to: number; key: number } | null; asking: boolean }) {
  const wire = (i: number) => {
    const next = stages[i + 1];
    if (!next) return null;
    const here = stages[i].state;
    const state = here === "done" ? (next.state === "running" || next.state === "asking" ? "live" : next.state === "skipped" ? "cut" : "lit") : here === "skipped" ? "cut" : "idle";
    return (
      <>
        <span className="fl-cwire" data-wire={state} data-tone={asking && next.state === "asking" ? "asking" : undefined}><i /></span>
        {pulse && pulse.to === i + 1 ? <span key={pulse.key} className="fl-pulse"><i /></span> : null}
      </>
    );
  };
  return (
    <ol className="fl-circuit" aria-label="The release, stage by stage">
      {stages.map((s, i) => (
        <li key={s.key} className="fl-cell" title={`${s.title}: ${s.state === "landed" ? "landed" : STATE_WORD[s.state]}`}>
          {wire(i)}
          <span className="fl-cnode" data-state={s.state} data-kind={s.key === "__end" ? "end" : undefined} data-out={s.outward ? "true" : undefined}>
            {s.state === "running" ? <span className="fl-cspin" /> : null}
            {s.state === "done" ? <Check size={16} strokeWidth={2.75} /> : s.state === "failed" ? <X size={16} strokeWidth={2.75} /> : s.key === "__end" ? <Flag size={15} strokeWidth={2.2} />
              : s.kind ? <KindGlyph kind={s.kind} size={15} /> : <CircleDashed size={15} />}
          </span>
          <span className="fl-clabel" data-state={s.state}>{s.title}</span>
          <span className="fl-ccount">{s.count}</span>
        </li>
      ))}
    </ol>
  );
}

export function Figure({ value, label, tone }: { value: number; label: string; tone?: "ok" | "bad" | "warn" }) {
  const shown = useTween(value, 900);
  return <span className="fl-figure" data-tone={tone}><b>{Math.round(shown)}</b><span>{label}</span></span>;
}

/** One dot per step, coloured by state; round dots leave Embodent. */
export function Thread({ dots, label }: { dots: ThreadDot[]; label: string }) {
  return (
    <span className="fl-thread" role="img" aria-label={label}>
      {dots.map((d, i) => <span key={d.id ?? i} className="fl-dot" data-kind={d.kind} data-state={d.state ?? "waiting"} data-out={d.outward ? "true" : undefined} title={d.title} />)}
    </span>
  );
}

const SCENE: { kind: StepKind; word: string; out?: boolean }[] = [
  { kind: "agent", word: "An agent fixes the batch" },
  { kind: "qa", word: "QA checks the changed screens" },
  { kind: "gate", word: "You see the proof and say Go" },
  { kind: "agent", word: "It ships to the store", out: true },
  { kind: "watch", word: "Store review is watched for you" },
];

/** The empty state's teaching scene: a release plays through, then rests on its finished frame. */
export function TeachScene() {
  const beats = SCENE.map((_, i) => 400 + i * 900);
  const { t, ref } = usePlayhead(beats, 400 + SCENE.length * 900 + 1400, 1e9);
  const at = beats.filter((b) => t >= b).length - 1;
  return (
    <div ref={ref} className="fl-teach-wrap" aria-hidden="true">
      <div className="fl-teach">
        {SCENE.map((s, i) => (
          <Fragment key={i}>
            {i > 0 ? <span className="fl-teach-wire" data-filled={at >= i}><i /></span> : null}
            <span className="fl-teach-node" data-kind={s.out ? "gate" : s.kind} data-on={at === i} data-done={at > i}>
              {s.out ? <ArrowUpRight size={17} /> : <KindGlyph kind={s.kind} size={17} />}
            </span>
          </Fragment>
        ))}
      </div>
      <p key={at} className="fl-teach-caption">{at >= 0 && at < SCENE.length ? SCENE[at].word : "A release, from batch to live"}</p>
    </div>
  );
}

export function Lockline({ children }: { children: ReactNode }) {
  return <span className="fl-lock"><Lock size={12} aria-hidden="true" />{children}</span>;
}
