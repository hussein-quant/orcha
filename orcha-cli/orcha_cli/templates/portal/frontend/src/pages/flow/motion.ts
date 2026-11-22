/**
 * Motion for the Workflows screens, ported from Verdikt Recipes (recipe-motion.ts, use-reorder.ts).
 * No animation library: CSS keyframes on transform and opacity, plus the Web Animations API for
 * the spring. Under reduced motion every hook rests on its finished state at once.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

const REDUCED = "(prefers-reduced-motion: reduce)";

function subscribeReduced(cb: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const mq = window.matchMedia(REDUCED);
  mq.addEventListener?.("change", cb);
  return () => mq.removeEventListener?.("change", cb);
}

/** Whether the viewer asked for less motion. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReduced,
    () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(REDUCED).matches,
    () => false,
  );
}

/**
 * A playhead for a teaching scene: `t` moves only at the scene's `beats`, so React renders a dozen
 * times a loop; CSS carries the motion between beats. Plays while on screen and the tab is visible;
 * under reduced motion rests on `end` (the finished frame).
 */
export function usePlayhead(beats: number[], loopMs: number, end: number): { t: number; ref: RefObject<HTMLDivElement>; reduced: boolean } {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const [t, setT] = useState(0);
  const [visible, setVisible] = useState(true);
  const key = beats.join(",");
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { threshold: 0.15 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    const onVis = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);
  useEffect(() => {
    if (reduced || !visible) return;
    let timers: ReturnType<typeof setTimeout>[] = [];
    const times = key.split(",").map(Number);
    const loop = () => {
      setT(0);
      timers = times.filter((b) => b > 0).map((b) => setTimeout(() => setT(b), b));
      timers.push(setTimeout(loop, loopMs));
    };
    timers.push(setTimeout(loop, 0));
    return () => timers.forEach(clearTimeout);
  }, [reduced, visible, key, loopMs]);
  return { t: reduced ? end : t, ref, reduced };
}

/** A number that eases to each new value (counts in the proof pack), at once under reduced motion. */
export function useTween(value: number, ms = 900): number {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(value);
  const current = useRef(value);
  useEffect(() => {
    const from = current.current;
    if (reduced || from === value) { current.current = value; setShown(value); return; }
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / ms);
      const v = from + (value - from) * (1 - Math.pow(1 - p, 3));
      current.current = v;
      setShown(v);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, ms, reduced]);
  return reduced ? value : shown;
}

/** A clock that ticks every `ms` while mounted and enabled (elapsed time). */
export function useNow(ms = 1000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms, enabled]);
  return now;
}

/**
 * Keyframes of a damped spring settling from `from` px to 0 (a translateY). Stiffness 340, damping
 * 26 on a unit mass: a short, soft overshoot, settled in about half a second.
 */
export function springKeyframes(from: number, { stiffness = 340, damping = 26, ms = 560, frames = 30 } = {}): Keyframe[] {
  const w0 = Math.sqrt(stiffness);
  const zeta = damping / (2 * w0);
  const out: Keyframe[] = [];
  for (let i = 0; i <= frames; i++) {
    const t = (i / frames) * (ms / 1000);
    let x: number;
    if (zeta < 1) {
      const wd = w0 * Math.sqrt(1 - zeta * zeta);
      x = from * Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t));
    } else {
      x = from * Math.exp(-w0 * t) * (1 + w0 * t);
    }
    out.push({ transform: `translateY(${i === frames ? 0 : x.toFixed(2)}px)` });
  }
  return out;
}

const SPRING_MS = 560;

/** Drag (or ↑/↓) to reorder a vertical list with a spring settle, announced for screen readers. */
export function useReorder({ ids, onMove, nameOf }: { ids: string[]; onMove: (from: number, to: number) => void; nameOf: (id: string) => string }) {
  const listRef = useRef<HTMLOListElement | null>(null);
  const before = useRef<Map<string, number> | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [said, setSaid] = useState("");
  const reduced = useReducedMotion();
  const order = ids.join("|");
  const items = () => [...(listRef.current?.querySelectorAll<HTMLElement>(":scope > [data-reorder-id]") ?? [])];
  const snapshot = () => new Map(items().map((el) => [el.dataset.reorderId ?? "", el.getBoundingClientRect().top]));

  useLayoutEffect(() => {
    const prev = before.current;
    if (!prev) return;
    before.current = null;
    for (const el of items()) {
      el.style.transition = "";
      el.style.transform = "";
      el.style.zIndex = "";
      const was = prev.get(el.dataset.reorderId ?? "");
      if (was == null || reduced) continue;
      const dy = was - el.getBoundingClientRect().top;
      if (Math.abs(dy) >= 1 && typeof el.animate === "function") el.animate(springKeyframes(dy), { duration: SPRING_MS, easing: "linear" });
    }
  }, [order, reduced]);

  function move(from: number, to: number) {
    if (to < 0 || to >= ids.length || from === to) return;
    before.current = snapshot();
    onMove(from, to);
    setSaid(`Moved ${nameOf(ids[from])} to place ${to + 1} of ${ids.length}.`);
  }

  function keyDown(index: number, e: KeyboardEvent<HTMLElement>) {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    move(index, index + (e.key === "ArrowUp" ? -1 : 1));
  }

  function start(index: number, e: ReactPointerEvent<HTMLElement>) {
    if (e.button !== 0) return;
    const els = items();
    const el = els[index];
    if (!el) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture?.(e.pointerId);
    const rects = els.map((x) => ({ top: x.offsetTop, h: x.offsetHeight }));
    const gap = rects.length > 1 ? (index + 1 < rects.length ? rects[index + 1].top - rects[index].top - rects[index].h : rects[index].top - rects[index - 1].top - rects[index - 1].h) : 0;
    const room = rects[index].h + gap;
    const startY = e.clientY;
    let to = index;
    let dy = 0;
    setDragging(ids[index]);
    el.style.transition = "none";
    el.style.zIndex = "20";
    els.forEach((x, i) => { if (i !== index) x.style.transition = reduced ? "none" : "transform 260ms cubic-bezier(0.25, 1.1, 0.4, 1)"; });
    const follow = (ev: PointerEvent) => {
      dy = ev.clientY - startY;
      el.style.transform = `translateY(${dy}px) scale(1.012)`;
      const middle = rects[index].top + rects[index].h / 2 + dy;
      to = index;
      els.forEach((x, i) => {
        if (i === index) return;
        const c = rects[i].top + rects[i].h / 2;
        let shift = 0;
        if (i > index && middle > c) { shift = -room; to = Math.max(to, i); }
        else if (i < index && middle < c) { shift = room; to = Math.min(to, i); }
        x.style.transform = shift ? `translateY(${shift}px)` : "";
      });
    };
    const done = () => {
      handle.removeEventListener("pointermove", follow);
      handle.removeEventListener("pointerup", done);
      handle.removeEventListener("pointercancel", done);
      setDragging(null);
      if (to !== index) { move(index, to); return; }
      for (const x of els) { x.style.transition = ""; x.style.transform = ""; x.style.zIndex = ""; }
      if (!reduced && Math.abs(dy) >= 1 && typeof el.animate === "function") el.animate(springKeyframes(dy), { duration: SPRING_MS, easing: "linear" });
    };
    handle.addEventListener("pointermove", follow);
    handle.addEventListener("pointerup", done);
    handle.addEventListener("pointercancel", done);
  }

  return { listRef, dragging, said, move, start, keyDown };
}

/**
 * Live moments only (Verdikt's useStageMoments): play a moment only for changes this page SAW.
 * A run opened after it finished shows its finished frame. Returns the ids whose state changed in
 * the last update (keyed by `take`), and whether the run just landed.
 */
export function useMoments(states: Record<string, string>, over: boolean) {
  const prev = useRef<{ states: Record<string, string>; over: boolean } | null>(null);
  const [moment, setMoment] = useState<{ take: number; landed: Set<string>; finished: boolean; stageDone: Set<string> }>({ take: 0, landed: new Set(), finished: false, stageDone: new Set() });
  const sig = JSON.stringify(states) + (over ? "|over" : "");
  useEffect(() => {
    const was = prev.current;
    prev.current = { states, over };
    if (!was) return; // first frame: no moment, the page opens on how things are
    const landed = new Set<string>();
    for (const [id, s] of Object.entries(states)) if (was.states[id] && was.states[id] !== s && (s === "done" || s === "failed")) landed.add(id);
    setMoment((m) => ({ take: m.take + 1, landed, finished: !was.over && over, stageDone: new Set() }));
  }, [sig]);
  return moment;
}

/** Debounce a value (the editor's live check waits ~600ms after the last change). */
export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

/** A polite live region's text: the newest announcement wins. */
export function useAnnounce(): [string, (text: string) => void] {
  const [text, setText] = useState("");
  const say = useCallback((t: string) => setText((old) => (old === t ? `${t} ` : t)), []);
  return [text, say];
}
