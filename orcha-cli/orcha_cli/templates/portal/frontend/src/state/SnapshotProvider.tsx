/**
 * The live container snapshot as React context: initial fetch + 3s poll +
 * the D6 sub-second event stream (EventSource with a since_ts cursor and
 * burst coalescing — port of data.js start/startEventStream). Also the
 * acting-human persistence (app.js actingHuman/setActingHuman) and the
 * attention aggregation (attnItems / autLevel, #367 autonomy-gated cards).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { fetchSnapshot, resolveCid } from "../api/client";
import type { Agent, OrchaRequest, Snapshot, Task } from "../types";

export interface SnapshotCtx {
  snap: Snapshot | null;
  cid: string | null;
  error: string | null;
  refresh: () => Promise<void>;
  bump: number; // increments every applied refresh (for effects keyed to polls)
}

const Ctx = createContext<SnapshotCtx>({
  snap: null,
  cid: null,
  error: null,
  refresh: async () => {},
  bump: 0,
});

export function SnapshotProvider({ children, pollMs = 3000 }: { children: ReactNode; pollMs?: number }) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [cid, setCid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bump, setBump] = useState(0);
  const cidRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      if (!cidRef.current) {
        cidRef.current = await resolveCid();
        setCid(cidRef.current);
      }
      if (!cidRef.current) throw new Error("no container found");
      const s = await fetchSnapshot(cidRef.current);
      setSnap(s);
      setError(null);
      setBump((b) => b + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    let alive = true;
    void refresh();
    const iv = setInterval(() => { if (alive) void refresh(); }, pollMs);

    // D6 live-push: react ONLY to NEW events (since_ts cursor, never replay
    // history), coalesce bursts, self-managed reconnect so the cursor advances.
    let es: EventSource | null = null;
    let cursor: number | null = null;
    let pending = false;
    let reconnectT: ReturnType<typeof setTimeout> | null = null;
    const connect = () => {
      if (!alive) return;
      if (!cidRef.current) { reconnectT = setTimeout(connect, 1000); return; }
      if (cursor == null) cursor = Date.now() / 1000;
      try {
        es = new EventSource("/api/containers/" + encodeURIComponent(cidRef.current) + "/events?since_ts=" + cursor);
      } catch {
        return;
      }
      es.onmessage = (ev) => {
        try {
          const ts = (JSON.parse(ev.data) as { ts?: number }).ts;
          if (ts != null) cursor = ts;
        } catch { /* non-JSON keepalive */ }
        if (pending) return;
        pending = true;
        setTimeout(() => { pending = false; if (alive) void refresh(); }, 150);
      };
      es.onerror = () => {
        try { es?.close(); } catch { /* already closed */ }
        reconnectT = setTimeout(connect, 3000);
      };
    };
    connect();

    return () => {
      alive = false;
      clearInterval(iv);
      if (reconnectT) clearTimeout(reconnectT);
      try { es?.close(); } catch { /* already closed */ }
    };
  }, [refresh, pollMs]);

  return <Ctx.Provider value={{ snap, cid, error, refresh, bump }}>{children}</Ctx.Provider>;
}

export function useSnapshot(): SnapshotCtx {
  return useContext(Ctx);
}

/* ---- derived helpers (ports of the app.js accessors) -------------------- */

export function agentByAlias(snap: Snapshot | null, alias: string | null | undefined): Agent | null {
  if (!snap || !alias) return null;
  return snap.agents.find((a) => a.alias === alias) || null;
}
export function agentById(snap: Snapshot | null, id: unknown): Agent | null {
  if (!snap || id == null) return null;
  return snap.agents.find((a) => String(a.id) === String(id)) || null;
}
export function taskById(snap: Snapshot | null, id: unknown): Task | null {
  if (!snap || id == null) return null;
  return snap.tasks.find((t) => String(t.id) === String(id)) || null;
}
export function humans(snap: Snapshot | null): Agent[] {
  return (snap?.agents ?? []).filter((a) => a.kind === "human");
}

// a request is "to the human" if its target resolves to a human agent, or has
// no explicit target (the API routes those to the picked human).
export function isToHuman(snap: Snapshot | null, r: OrchaRequest): boolean {
  if (r.target_id !== undefined) {
    if (!r.target_id) return true;
    const t = agentById(snap, r.target_id);
    return !!t && t.kind === "human";
  }
  if (r.to === "human") return true;
  const a = agentByAlias(snap, r.to);
  return !!(a && a.kind === "human");
}

/* ---- acting-as (persisted; NOT hardcoded) -------------------------------- */
function actingKey(snap: Snapshot | null): string {
  return "orcha:actingHuman:" + (snap?.container?.id || "_");
}
export function actingHuman(snap: Snapshot | null): Agent | null {
  const hs = humans(snap);
  if (!hs.length) return null;
  let saved: string | null = null;
  try { saved = localStorage.getItem(actingKey(snap)); } catch { /* private mode */ }
  if (saved) {
    const m = hs.find((h) => String(h.id) === String(saved));
    if (m) return m;
  }
  return hs[0];
}
export function setActingHuman(snap: Snapshot | null, id: string): void {
  try { localStorage.setItem(actingKey(snap), String(id)); } catch { /* private mode */ }
}

/* ---- autonomy + attention (#367) ----------------------------------------- */
export function autLevel(snap: Snapshot | null): string {
  return snap?.container?.autonomy_level || "plan";
}

export function planMessageOf(t: Task): { body: string; from: string | null; at?: string; is_human: boolean } | null {
  if (t.plan_message) {
    return { body: t.plan_message.body, from: t.plan_message.author_alias || null, at: t.plan_message.at, is_human: false };
  }
  const m = (t.thread || []).filter((x) => !x.is_human);
  return m.length ? { body: m[0].body, from: m[0].from, at: m[0].at, is_human: false } : null;
}
export function pendingPlan(t: Task): boolean {
  return t.status === "in_progress" && !t.plan_decision && !!planMessageOf(t);
}

export interface AttnItems {
  plans: Task[];
  verifs: Task[];
  escs: OrchaRequest[];
  count: number;
}
export function attnItems(snap: Snapshot | null): AttnItems {
  const lvl = autLevel(snap);
  const tasks = snap?.tasks ?? [];
  const reqs = snap?.requests ?? [];
  const plans = lvl === "plan" ? tasks.filter(pendingPlan) : [];
  const verifs = lvl === "full" ? [] : tasks.filter((t) => t.status === "needs_verification");
  const escs = reqs.filter((r) => r.status === "open" && isToHuman(snap, r));
  return { plans, verifs, escs, count: plans.length + verifs.length + escs.length };
}
