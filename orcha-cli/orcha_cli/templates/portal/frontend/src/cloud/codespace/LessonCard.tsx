/**
 * Learn — an agent's teach/why answer rendered as a LESSON, not a chat log:
 * title, one-line summary, a stepped walkthrough (progress + Prev/Next + ←/→),
 * key-concept chips and one-click follow-up questions.
 *
 * Every step that cites lines (lesson.ts parseLineRefs) drives the editor: the
 * active step's local refs are handed to `onFocusLines`, which CodeSpacePage turns
 * into a smooth scroll + a soft glow on those lines with the rest dimmed. A plain
 * prose answer (structured=false) steps paragraph by paragraph the same way.
 *
 * Motion is CSS only (codespace.css `.cs-lesson*`): a staggered reveal on mount
 * (`--i` per block) and a directional slide when the active step changes; all of
 * it is disabled under prefers-reduced-motion.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Avatar, Button, Chip } from "../../components/primitives";
import { isEditingTarget } from "../../components/primitives";
import { Icon, Md } from "../../components/ui";
import { relTime } from "../../lib/format";
import type { ThreadKind } from "./codespaceTypes";
import type { FocusRange } from "./editorLessonFocus";
import { baseName, localRefs, refLabel, type Lesson, type LineRef } from "./lesson";
import { KindChip } from "./threadBits";

export interface LessonCardProps {
  lesson: Lesson;
  kind: ThreadKind;
  /** The lesson's anchor file (refs without a path point here). */
  path: string;
  anchor: { start: number; end: number };
  agentAlias?: string | null;
  agentKind?: "ai" | "human";
  answeredAt?: string | null;
  onFocusLines?: (ranges: FocusRange[] | null) => void;
  /** A ref naming ANOTHER file was clicked. */
  onOpenFileRef?: (ref: LineRef) => void;
  onFollowUp?: (question: string) => void;
  /** Follow-up currently being created (disables its button). */
  followUpBusy?: string | null;
  initialStep?: number;
  /** Listen for ←/→ on the document (default true; the card is the only lesson on screen). */
  globalKeys?: boolean;
}

function stepRanges(refs: LineRef[], path: string): FocusRange[] | null {
  const local = localRefs(refs, path);
  return local.length ? local.map((r) => ({ start: r.start, end: r.end })) : null;
}

export function LessonCard({
  lesson,
  kind,
  path,
  anchor,
  agentAlias,
  agentKind,
  answeredAt,
  onFocusLines,
  onOpenFileRef,
  onFollowUp,
  followUpBusy,
  initialStep = 0,
  globalKeys = true,
}: LessonCardProps) {
  const total = lesson.steps.length;
  const [step, setStep] = useState(() => Math.min(Math.max(0, initialStep), Math.max(0, total - 1)));
  const [dir, setDir] = useState<"fwd" | "back">("fwd");
  // an explicit ref chip click overrides the step's own ranges until the step changes
  const [pinned, setPinned] = useState<FocusRange[] | null>(null);
  const stepRefs = useRef<(HTMLLIElement | null)[]>([]);
  const onFocusRef = useRef(onFocusLines);
  onFocusRef.current = onFocusLines;

  const go = useCallback((next: number) => {
    setStep((cur) => {
      const n = Math.min(Math.max(0, next), Math.max(0, total - 1));
      if (n !== cur) { setDir(n > cur ? "fwd" : "back"); setPinned(null); }
      return n;
    });
  }, [total]);

  // drive the editor: the active step's cited lines (or a pinned ref)
  const active = lesson.steps[step];
  const focusKey = JSON.stringify(pinned ?? (active ? stepRanges(active.refs, path) : null));
  useEffect(() => {
    onFocusRef.current?.(JSON.parse(focusKey));
  }, [focusKey]);
  // leaving the lesson clears the glow/dim
  useEffect(() => () => onFocusRef.current?.(null), []);

  // keep the active step in view inside the rail
  useEffect(() => {
    const el = stepRefs.current[step];
    if (el && typeof el.scrollIntoView === "function") {
      const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      el.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
    }
  }, [step]);

  // ←/→ step (never while typing, in a select, on a tab strip or inside an editor)
  useEffect(() => {
    if (!globalKeys) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      const t = e.target as Element | null;
      if (isEditingTarget(t) || (t && (t as HTMLElement).closest?.('[role="tablist"], [role="slider"], [role="separator"]'))) return;
      e.preventDefault();
      go(e.key === "ArrowRight" ? step + 1 : step - 1);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [globalKeys, go, step]);

  const clickRef = (i: number, r: LineRef) => {
    if (r.path && localRefs([r], path).length === 0) { onOpenFileRef?.(r); return; }
    if (i !== step) go(i);
    setPinned([{ start: r.start, end: r.end }]);
  };

  const pct = total ? Math.round(((step + 1) / total) * 100) : 0;
  const anchorText = baseName(path) + ":" + (anchor.start === anchor.end ? anchor.start : anchor.start + "–" + anchor.end);

  return (
    <article className={"cs-lesson" + (lesson.structured ? " is-structured" : " is-prose")} aria-label={"Lesson: " + lesson.title} aria-roledescription="lesson">
      <header className="cs-lesson-head cs-reveal" style={{ ["--i" as string]: 0 }}>
        <div className="cs-lesson-eyebrow">
          <KindChip kind={kind} />
          <span className="cs-lesson-anchor mono" title={path}>{anchorText}</span>
        </div>
        <h2 className="cs-lesson-title">{lesson.title}</h2>
        {lesson.summary ? <p className="cs-lesson-summary">{lesson.summary}</p> : null}
        {agentAlias ? (
            <span className="cs-lesson-by" title={"Answered by @" + agentAlias}>
              <Avatar alias={agentAlias} kind={agentKind ?? "ai"} size={20} decorative />
              <span className="cs-lesson-by-name">@{agentAlias}</span>
              {answeredAt ? <span className="cs-lesson-by-time">· {relTime(answeredAt)}</span> : null}
            </span>
          ) : null}
      </header>

      {total > 1 ? (
        <div className="cs-lesson-progress cs-reveal" style={{ ["--i" as string]: 1 }}>
          <div
            className="cs-lesson-bar"
            role="progressbar"
            aria-label="Lesson progress"
            aria-valuemin={1}
            aria-valuemax={total}
            aria-valuenow={step + 1}
            aria-valuetext={"Step " + (step + 1) + " of " + total}
          >
            <span style={{ width: pct + "%" }} />
          </div>
          <span className="cs-lesson-count" aria-hidden="true">{step + 1} / {total}</span>
        </div>
      ) : null}

      <ol className={"cs-lesson-steps dir-" + dir}>
        {lesson.steps.map((s, i) => {
          const state = i === step ? " is-active" : i < step ? " is-done" : "";
          return (
            <li
              key={i}
              ref={(el) => { stepRefs.current[i] = el; }}
              className={"cs-lesson-step cs-reveal" + state}
              style={{ ["--i" as string]: 2 + Math.min(i, 6) }}
              aria-current={i === step ? "step" : undefined}
            >
              <button type="button" className="cs-lesson-step-dot" onClick={() => go(i)} aria-label={"Go to step " + (i + 1)}>
                {i < step ? <Icon name="check" cls="v2-ico" /> : i + 1}
              </button>
              <div className="cs-lesson-step-main" onClick={() => { if (i !== step) go(i); }}>
                {s.title ? <div className="cs-lesson-step-title">{s.title}</div> : null}
                {s.body ? <Md text={s.body} className={"cs-lesson-step-body tx md" + (i === step ? " is-entering" : "")} /> : null}
                {s.refs.length ? (
                  <div className="cs-lesson-refs">
                    {s.refs.map((r) => {
                      const other = !!r.path && localRefs([r], path).length === 0;
                      return (
                        <button
                          key={(r.path ?? "") + r.start + "-" + r.end}
                          type="button"
                          className={"cs-lesson-ref mono" + (other ? " is-other" : "")}
                          title={other ? "Open " + r.path + " at line " + r.start : "Highlight " + refLabel(r)}
                          onClick={(e) => { e.stopPropagation(); clickRef(i, r); }}
                        >
                          {other ? baseName(r.path!) + ":" : ""}{refLabel(r)}
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>

      {total > 1 ? (
        <div className="cs-lesson-nav cs-reveal" style={{ ["--i" as string]: 3 }}>
          <Button size="sm" variant="ghost" icon="chev-left" onClick={() => go(step - 1)} disabled={step === 0} aria-label="Previous step">
            Prev
          </Button>
          <span className="cs-lesson-keys" aria-hidden="true"><kbd>←</kbd><kbd>→</kbd></span>
          <Button size="sm" variant={step === total - 1 ? "ghost" : "secondary"} iconRight="chev-right" onClick={() => go(step + 1)} disabled={step === total - 1} aria-label="Next step">
            Next
          </Button>
        </div>
      ) : null}

      {lesson.concepts.length ? (
        <section className="cs-lesson-concepts cs-reveal" style={{ ["--i" as string]: 4 }} aria-label="Key concepts">
          <div className="cs-lesson-label">Key concepts</div>
          <div className="cs-lesson-chips">
            {lesson.concepts.map((c) => (
              <Chip key={c} size="sm" dot="auto" dotKey={c}>{c}</Chip>
            ))}
          </div>
        </section>
      ) : null}

      {lesson.followUps.length && onFollowUp ? (
        <section className="cs-lesson-followups cs-reveal" style={{ ["--i" as string]: 5 }} aria-label="Follow-up questions">
          <div className="cs-lesson-label">Go deeper</div>
          {lesson.followUps.map((q) => (
            <button
              key={q}
              type="button"
              className="cs-lesson-followup"
              disabled={!!followUpBusy}
              aria-busy={followUpBusy === q || undefined}
              onClick={() => onFollowUp(q)}
              title="Ask this as a new lesson"
            >
              <Icon name="spark" cls="v2-ico" />
              <span>{q}</span>
              <Icon name="arrow" cls="v2-ico cs-lesson-followup-go" />
            </button>
          ))}
        </section>
      ) : null}
    </article>
  );
}
