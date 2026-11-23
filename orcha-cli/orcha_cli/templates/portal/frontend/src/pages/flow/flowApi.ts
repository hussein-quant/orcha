/**
 * The new Workflows screens' API: templates, the live check, one Start, people's decisions,
 * watch steps, the proof pack and the board. Every call names the person acting (the local
 * actor header), exactly like the classic Workflows client.
 */
import { errorDetailText } from "../../api/client";

export type StepKind = "agent" | "person" | "qa" | "watch" | "gate";
export type Platform = "ios" | "android" | "web" | "api";

export class FlowError extends Error {
  status: number;
  code: string | null;
  detail: Record<string, unknown> | null;
  constructor(message: string, status: number, code: string | null, detail: Record<string, unknown> | null) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

async function call<T>(method: "GET" | "POST" | "DELETE" | "PATCH", url: string, actorId: string | null, body?: unknown, signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (actorId) headers["X-Orcha-Local-Actor"] = actorId;
  const r = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal });
  if (!r.ok) {
    let detail: unknown = null;
    try { detail = ((await r.json()) as { detail?: unknown }).detail; } catch { /* not JSON */ }
    const obj = detail && typeof detail === "object" && !Array.isArray(detail) ? (detail as Record<string, unknown>) : null;
    throw new FlowError(errorDetailText(detail) || `The server said ${r.status}.`, r.status, obj && typeof obj.code === "string" ? obj.code : null, obj);
  }
  return r.json() as Promise<T>;
}

export const newKey = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`);

/* ---- templates ------------------------------------------------------------------- */

export interface ThreadDot { kind: StepKind; outward: boolean; stage?: string; state?: string; id?: string; title?: string }

export interface TemplateSummary {
  key: string; name: string; version: number; description: string; icon: string; tone: string;
  source: "builtin" | "project"; stage_count: number; step_count: number; gates: number; watches: number;
  outward: number; thread: ThreadDot[]; base_key?: string | null; base_version?: number | null; update_available?: boolean;
  /** The template can read the project's release inventory: it opens on the Release home. */
  has_inventory?: boolean;
}

/** What runs somewhere. For web and API, `commit` is the commit the deploy stamped on the server and
 *  `behind` the commits on main that touch the platform's code since it (0 = up to date). */
export interface DeployReading {
  version?: string | null; since?: string | null; source?: string; url?: string; build_id?: string | string[] | null;
  commit?: string | null; behind?: number | null; dirty?: boolean; deployed_at?: string | null;
}
export interface InventoryPlatform {
  last_release?: { tag: string; version?: string; build?: number; date?: string } | null;
  live?: DeployReading | null;
  staging?: DeployReading | null;
  in_flight?: { state?: string; summary?: string; terminal?: boolean; data?: { version?: string } } | null;
  changes: { sha: string; pr: number | null; title: string; merged_at?: string }[];
  next?: { version: string | null; build: number | null; reason?: string } | null;
}
export interface Inventory {
  state: string; summary?: string | null; error?: string | null; read_at: string; cached: boolean; command: string;
  data: {
    platforms?: Partial<Record<Platform, InventoryPlatform>>;
    open_prs?: { number: number; title: string; url: string; draft: boolean; branch: string; updated_at?: string; platforms: Platform[] }[];
    release_params?: Record<string, unknown> & { platforms?: Platform[] };
    warnings?: string[];
  };
}

export interface TemplateParam {
  key: string; label: string; type: "platforms" | "text" | "longtext" | "number" | "choice";
  default?: unknown; required?: boolean; placeholder?: string; help?: string; platform?: Platform; advanced?: boolean;
  /** Set by whatever made the workflow (a release cycle), never typed in the editor. */
  hidden?: boolean;
  choices?: { value: string; label: string }[];
}

export interface TemplateRole { key: string; label: string; kind: "human" | "ai" }

export interface CompiledStep {
  client_key: string; title: string; kind: StepKind; stage: string; role: string | null;
  required: boolean; locked_reason: string | null; removed: boolean; removed_why?: "platform" | "condition" | "removed";
  platforms: Platform[]; irreversible: boolean; outward: string | null; done_when: string; description: string;
  after: string[]; loop: string | null; branches: { outcome: string; destination: string; to?: string | null }[];
  assignee_id: string | null; added: boolean;
}

export interface Problem { code: string; message: string; task_id?: string | null; param?: string; role?: string; group?: string | null }

export interface Compiled {
  steps: CompiledStep[]; stages: { key: string; title: string }[];
  loops: { name: string; members: string[]; review: string; max_rounds: number }[];
  parameters: TemplateParam[]; roles: TemplateRole[]; values: Record<string, unknown>;
  problems: Problem[]; ready: boolean; template: TemplateSummary;
  people: { id: string; alias: string; kind: "human" | "ai"; role: string | null }[];
}

export interface AddedStep {
  client_key: string; title: string; kind: StepKind; role?: string | null; insert_after?: string; definition_of_done: string; description?: string;
  outcomes?: { name: string; kind: string }[]; routes?: { outcome: string; destination: string }[];
  qa?: { kind: "check"; focus?: string }; watch?: Record<string, unknown>; dry_run?: { outcomes: string[] };
}

export interface CompileInput { params: Record<string, unknown>; removed: string[]; added: AddedStep[]; roles: Record<string, string | null>; dry_run: boolean }

export const flowApi = {
  templates: (cid: string, actor: string | null, signal?: AbortSignal) =>
    call<{ templates: TemplateSummary[] }>("GET", `/api/containers/${encodeURIComponent(cid)}/workflow-templates`, actor, undefined, signal),
  compile: (cid: string, key: string, actor: string | null, input: CompileInput, signal?: AbortSignal) =>
    call<Compiled>("POST", `/api/containers/${encodeURIComponent(cid)}/workflow-templates/${encodeURIComponent(key)}/compile`, actor, input, signal),
  create: (cid: string, actor: string | null, input: CompileInput & { key: string; start: boolean; title?: string }) =>
    call<FlowDetail>("POST", `/api/containers/${encodeURIComponent(cid)}/workflows/from-template`, actor, { ...input, idempotency_key: newKey() }),
  saveVariant: (cid: string, actor: string | null, body: { from_key: string; key: string; name: string } & Omit<CompileInput, "dry_run">) =>
    call<TemplateSummary>("POST", `/api/containers/${encodeURIComponent(cid)}/workflow-templates`, actor, body),
  importTemplate: (cid: string, actor: string | null, template: unknown) =>
    call<TemplateSummary>("POST", `/api/containers/${encodeURIComponent(cid)}/workflow-templates`, actor, { template }),
  exportUrl: (cid: string, key: string) => `/api/containers/${encodeURIComponent(cid)}/workflow-templates/${encodeURIComponent(key)}/export`,
  inventory: (cid: string, key: string, actor: string | null, refresh: boolean, signal?: AbortSignal) =>
    call<Inventory>("GET", `/api/containers/${encodeURIComponent(cid)}/workflow-templates/${encodeURIComponent(key)}/inventory?refresh=${refresh}`, actor, undefined, signal),
  board: (cid: string, actor: string | null, finished: boolean, signal?: AbortSignal) =>
    call<Board>("GET", `/api/containers/${encodeURIComponent(cid)}/workflow-board?include_finished=${finished}`, actor, undefined, signal),
  detail: (wid: string, actor: string | null, signal?: AbortSignal) =>
    call<FlowDetail>("GET", `/api/workflows/${encodeURIComponent(wid)}`, actor, undefined, signal),
  proof: (wid: string, actor: string | null, gate?: string | null, signal?: AbortSignal) =>
    call<Proof>("GET", `/api/workflows/${encodeURIComponent(wid)}/proof${gate ? `?step=${encodeURIComponent(gate)}` : ""}`, actor, undefined, signal),
  launch: (d: FlowDetail, actor: string | null) =>
    call<FlowDetail>("POST", `/api/workflows/${encodeURIComponent(d.id)}/launch`, actor, { expected_revision: d.revision, idempotency_key: newKey(), reason: "" }),
  decide: (wid: string, tid: string, actor: string | null, body: { choice?: "go" | "no_go" | "send_back"; outcome?: string; reason?: string; send_back_to?: string | null; proof_digest?: string | null }) =>
    call<FlowDetail>("POST", `/api/workflows/${encodeURIComponent(wid)}/steps/${encodeURIComponent(tid)}/decide`, actor, body),
  checkNow: (wid: string, tid: string, actor: string | null) =>
    call<{ reading: WatchReading; outcome: string | null; workflow: FlowDetail }>("POST", `/api/workflows/${encodeURIComponent(wid)}/steps/${encodeURIComponent(tid)}/check-now`, actor, {}),
  resolve: (wid: string, tid: string, actor: string | null, state: string) =>
    call<FlowDetail>("POST", `/api/workflows/${encodeURIComponent(wid)}/steps/${encodeURIComponent(tid)}/resolve`, actor, { state }),
  loopDecision: (d: FlowDetail, actor: string | null, body: { kind: "pick_outcome" | "stop" | "raise_limit" | "accept_override" | "resume_stalled"; task_id: string; outcome?: string; note?: string; new_max_rounds?: number }) =>
    call<FlowDetail>("POST", `/api/workflows/${encodeURIComponent(d.id)}/decisions`, actor, { expected_revision: d.revision, idempotency_key: newKey(), reason: "", ...body }),
  simple: (d: FlowDetail, actor: string | null, action: "pause" | "resume" | "cancel") =>
    call<FlowDetail>("POST", `/api/workflows/${encodeURIComponent(d.id)}/${action}`, actor, { expected_revision: d.revision, idempotency_key: newKey(), reason: action === "cancel" ? "Stopped from the run page." : "" }),
  close: (wid: string, actor: string | null, note: string) =>
    call<FlowDetail>("POST", `/api/workflows/${encodeURIComponent(wid)}/close`, actor, { note }),
  snooze: (wid: string, actor: string | null, days = 3) =>
    call<FlowDetail>("POST", `/api/workflows/${encodeURIComponent(wid)}/snooze`, actor, { days }),
  nextRelease: (wid: string, actor: string | null) =>
    call<{ key: string; params: Record<string, unknown>; removed: string[]; from: string }>("GET", `/api/workflows/${encodeURIComponent(wid)}/next-release`, actor),
  markFinding: (fid: string, actor: string | null, action: "mark_fixed" | "mark_verified", fixed_ref?: string) =>
    call<unknown>("PATCH", `/api/qa/findings/${encodeURIComponent(fid)}`, actor, { action, fixed_ref }),
};

/* ---- the board -------------------------------------------------------------------- */

export interface BoardRow {
  id: string; title: string; status: "active" | "paused" | "completed" | "cancelled"; launch_enabled: boolean;
  template: { key: string; name: string } | null; dry_run: boolean;
  thread: (ThreadDot & { id: string; title: string; state: string })[];
  waiting_for_you: number; stage: string | null; created_at: string; last_activity: string | null;
  stalled: { since: string; days: number } | null; finished: boolean; done: number; total: number;
}
export interface Board { workflows: BoardRow[]; finished_count: number; stall_days: number; cycles?: Cycle[]; ticket_workflows?: number }

/* ---- release cycles ----------------------------------------------------------------- */

export interface CycleTicket {
  id: string; issue_number: number | null; issue_url: string | null; title: string; kind: "bug" | "feature";
  platforms: Platform[]; source: "manual" | "github"; state: "active" | "shipped" | "dropped"; workflow_id: string | null;
  rolled_from_cycle_id: string | null; created_at: string;
  /** Where it is, in the owner's words: "Waiting for your merge", "Ready to ship"… */
  word: string;
  /** Its column on the board. */
  phase: "spec" | "build" | "review" | "checking" | "ready" | "shipped" | "stopped";
  /** Who builds it. */
  engineer: string | null; tone: "muted" | "running" | "asking" | "ok";
  merged: boolean; checked: boolean; needs_you: boolean;
  step: { id: string; title: string; state: string } | null;
  thread: (ThreadDot & { id: string; title: string; state: string })[]; done: number; total: number;
  workflow_status: string | null;
}
export type CycleKind = "release" | "hotfix";
export interface Cycle {
  id: string; container_id: string; kind: CycleKind; version: string; branch: string; base_branch: string; milestone: string | null;
  state: "open" | "cut" | "closed"; platforms: Platform[]; roles: Record<string, string>; engineers: Partial<Record<Platform, string>>;
  dry_run: boolean; branch_state: "pending" | "created" | "existed" | "failed" | "skipped"; branch_note: string | null;
  created_at: string; cut_at: string | null;
  release_workflow: { id: string; title: string; status: string; dry_run: boolean } | null;
  next_cycle: { id: string; version: string; branch: string } | null;
  previous_cycle: { id: string; version: string } | null;
  counts: { total: number; merged: number; checked: number; needs_you: number; building: number };
  cut: { ships: string[]; rolls: string[]; platforms: Platform[]; unchecked: string[]; next_version: string; next_branch: string; next_is_open?: boolean };
  release_params: Record<string, unknown> & { platforms: Platform[]; batch_summary: string };
  tickets?: CycleTicket[];
}
export interface GithubIssue {
  number: number; title: string; body: string; url: string; labels: string[]; platforms: Platform[];
  kind: "bug" | "feature"; kind_from_labels: boolean; in_cycle?: string | null;
}
export interface NewTicket {
  issue_number?: number | null; title?: string; body?: string; url?: string | null; kind?: "bug" | "feature";
  platforms: Platform[]; engineer_id?: string | null; labels?: string[]; source?: "manual" | "github";
  /** Also open it on GitHub, in the cycle's milestone. A person ticks it; never on by default. */
  create_issue?: boolean;
  /** Screenshots and recording frames from the intake conversation, carried to the ticket's agent. */
  attachments?: { conversation_id: string; id: string; name: string }[];
}

/* ---- the intake: logging issues by talking them through ------------------------------------- */

export interface ConvAttachment { id: string; name: string; size?: number; kind?: "image" | "file"; url?: string; content_type?: string; t?: number }
export interface Turn {
  id: string; conversation_id: string; seq: number; role: "human" | "agent"; author_agent_id: string; content: string;
  meta?: Record<string, unknown> | string | null; attachments?: ConvAttachment[] | string | null; created_at: string;
}
export interface VideoFrames {
  video: { name: string; size: number; duration: number; width: number | null; height: number | null };
  frames: ConvAttachment[]; sheet: ConvAttachment | null;
}
async function upload<T>(url: string, file: File, actor: string | null): Promise<T> {
  const fd = new FormData();
  fd.append("file", file, file.name);
  const r = await fetch(url, { method: "POST", body: fd, headers: actor ? { "X-Orcha-Local-Actor": actor } : undefined });
  if (!r.ok) {
    let detail: unknown = null;
    try { detail = ((await r.json()) as { detail?: unknown }).detail; } catch { /* not JSON */ }
    throw new FlowError(errorDetailText(detail) || `The upload failed (${r.status}).`, r.status, null, null);
  }
  return r.json() as Promise<T>;
}
export const intakeApi = {
  get: (cycleId: string, actor: string | null) =>
    call<{ agent_id: string | null; brief: string; marker: [string, string] }>("GET", `${cyc(cycleId)}/intake`, actor),
  start: (agentId: string, actor: string | null) =>
    call<{ conversation: { id: string; status: string } }>("POST", `/api/agents/${encodeURIComponent(agentId)}/conversations`, actor, { actor_agent_id: actor }),
  turns: (convId: string, actor: string | null, signal?: AbortSignal) =>
    call<{ turns: Turn[] }>("GET", `/api/conversations/${encodeURIComponent(convId)}/turns?limit=1000`, actor, undefined, signal),
  say: (convId: string, actor: string, content: string, attachments: ConvAttachment[], cycleId: string) =>
    call<{ turn: Turn }>("POST", `/api/conversations/${encodeURIComponent(convId)}/turns`, actor, {
      role: "human", author_agent_id: actor, content, meta: { intake_cycle: cycleId },
      attachments: attachments.length ? attachments.map((a) => ({ id: a.id, name: a.name })) : undefined,
    }),
  image: (convId: string, file: File, actor: string | null) => upload<ConvAttachment>(`/api/conversations/${encodeURIComponent(convId)}/attachments`, file, actor),
  video: (convId: string, file: File, actor: string | null) => upload<VideoFrames>(`/api/conversations/${encodeURIComponent(convId)}/videos`, file, actor),
};

/** A ticket the intake agent proposed in an `orcha-ticket` block. */
export interface ProposedTicket { title: string; kind: "bug" | "feature"; platforms: Platform[]; body: string; attachments: string[] }

/** The agent's words, and the tickets it proposed, from one reply. */
export function readReply(text: string): { words: string; tickets: ProposedTicket[] } {
  const tickets: ProposedTicket[] = [];
  const words = text.replace(/```orcha-ticket\s*([\s\S]*?)```/g, (_m, body: string) => {
    try {
      const t = JSON.parse(body) as Partial<ProposedTicket>;
      if (t && typeof t.title === "string" && t.title.trim()) {
        tickets.push({
          title: t.title.trim().slice(0, 200), kind: t.kind === "feature" ? "feature" : "bug",
          platforms: (Array.isArray(t.platforms) ? t.platforms : []).filter((p): p is Platform => ["ios", "android", "web", "api"].includes(p as string)),
          body: typeof t.body === "string" ? t.body : "", attachments: Array.isArray(t.attachments) ? t.attachments.map(String) : [],
        });
        return "";
      }
    } catch { /* not JSON: leave the block as the agent wrote it */ }
    return _m;
  }).replace(/\n{3,}/g, "\n\n").trim();
  return { words, tickets };
}

/** What a person wrote, without the brief that went with their first message. */
export function withoutBrief(text: string, marker: [string, string] = ["[[intake-brief]]", "[[/intake-brief]]"]): string {
  const a = text.indexOf(marker[0]);
  const b = text.indexOf(marker[1]);
  return a >= 0 && b > a ? (text.slice(0, a) + text.slice(b + marker[1].length)).trim() : text;
}

const cyc = (id: string) => `/api/release-cycles/${encodeURIComponent(id)}`;
export const cycleApi = {
  list: (cid: string, actor: string | null, signal?: AbortSignal) =>
    call<{ cycles: Cycle[]; open: string | null; open_dry_run: string | null; open_hotfix: string | null; open_hotfix_dry_run: string | null; suggested: { version: string | null; branch: string | null } }>("GET", `/api/containers/${encodeURIComponent(cid)}/release-cycles`, actor, undefined, signal),
  open: (cid: string, actor: string | null, body: { kind: CycleKind; version: string; branch?: string; base_branch?: string; milestone?: string; platforms: Platform[]; roles: Record<string, string | null>; engineers: Record<string, string | null>; create_branch: boolean; dry_run: boolean }) =>
    call<Cycle>("POST", `/api/containers/${encodeURIComponent(cid)}/release-cycles`, actor, body),
  get: (id: string, actor: string | null, signal?: AbortSignal) => call<Cycle>("GET", cyc(id), actor, undefined, signal),
  settings: (id: string, actor: string | null, body: { roles?: Record<string, string | null>; engineers?: Record<string, string | null>; milestone?: string }) =>
    call<Cycle>("PATCH", cyc(id), actor, body),
  branch: (id: string, actor: string | null) => call<Cycle>("POST", `${cyc(id)}/branch`, actor, {}),
  github: (id: string, actor: string | null, signal?: AbortSignal) =>
    call<{ milestone: string; issues: GithubIssue[]; error: string | null }>("GET", `${cyc(id)}/github`, actor, undefined, signal),
  issue: (id: string, n: number, actor: string | null) => call<GithubIssue>("GET", `${cyc(id)}/github/issues/${n}`, actor),
  addTicket: (id: string, actor: string | null, body: NewTicket) => call<Cycle>("POST", `${cyc(id)}/tickets`, actor, body),
  dropTicket: (id: string, tid: string, actor: string | null) => call<Cycle>("POST", `${cyc(id)}/tickets/${encodeURIComponent(tid)}/drop`, actor, {}),
  cut: (id: string, actor: string | null, body: CompileInput & { next_version?: string }) =>
    call<{ cycle: Cycle; release_workflow_id: string; next_cycle_id: string }>("POST", `${cyc(id)}/cut`, actor, {
      params: body.params, removed: body.removed, added: body.added, roles: body.roles, next_version: body.next_version, idempotency_key: newKey(),
    }),
};

/* ---- a run --------------------------------------------------------------------- */

export interface WatchReading { state: string; terminal?: boolean; summary?: string; detail_url?: string | null; source?: string; error?: string | null; observed_at?: string; created_at?: string; timed_out?: boolean }

export interface StepSpec {
  kind: StepKind; key?: string | null; stage?: string | null; stage_title?: string | null; role?: string | null;
  person_id?: string | null; required?: boolean; platforms?: Platform[]; irreversible?: boolean; outward?: string | null;
  resources?: string[]; scope?: "subset" | "full" | null; coverage_threshold?: number | null;
  watch?: { state_map?: Record<string, string>; adapter?: { command?: string | null; http?: string | null }; interval_s?: number } | null;
  gate?: { choices?: ("go" | "no_go" | "send_back")[]; require_reason?: string[]; proof_steps?: string[] } | null;
  build?: { type?: string | null; version?: string | null; build?: string | null; commit?: string | null; env?: string | null } | null;
  secrets?: string[];
}

export interface FlowTask {
  id: string; title: string; description?: string | null; definition_of_done: string; status: string; work_revision: number;
  preparation_state: string | null; start_hold: boolean; human_hold_by: string | null; assignee_ids: string[]; depends_on: string[];
  can_start: boolean; blockers: { code: string; message: string }[]; display_state: { label: string; warning?: string | null };
  outcomes: { name: string; kind?: string }[]; routes: { outcome: string; destination: string; destination_task?: string | null }[];
  qa?: { kind: string; platform?: string | null; focus?: string | null } | null;
  route_state?: "not_selected" | null; awaiting_loop_decision?: "limit_reached" | "stalled" | "missing_outcome" | "ask_owner" | null;
  repeat_group_id?: string | null; round?: number | null;
  reported_outcome?: { outcome: string; findings?: { id: string; text: string; severity: string }[]; note?: string; reporter_kind?: string | null; applied?: boolean } | null;
  acceptance?: { actor_alias?: string; accepted_at?: string; created_at?: string } | null;
  step?: StepSpec | null;
  watch?: {
    latest: WatchReading | null; observations: WatchReading[]; next_check_at?: string | null; attempts: number;
    /** The adapter itself failed: not a store state. */
    error?: string | null;
    /** Readings stopped: only a person can settle this one. */
    needs_owner?: string | null;
    outcomes?: string[];
  } | null;
  /** Every outcome this step reported, oldest first, with its loop round. */
  history?: StepReport[] | null;
  withdrawn_at?: string | null;
}

export interface StepReport { round: number | null; outcome: string; note?: string; findings?: string[]; reported_at?: string | null; reporter_kind?: string | null }

export interface FlowDetail {
  id: string; container_id: string; title: string; goal: string; owner_human_id: string;
  status: "active" | "paused" | "completed" | "cancelled"; launch_enabled: boolean; revision: number; created_at?: string | null;
  tasks: FlowTask[]; progress: { accepted: number; total: number; percent: number | null };
  completion: { can_finish: boolean; blockers: { code: string; message: string }[] };
  repeat_groups?: { id: string; name: string; member_tasks: string[]; review_task: string; max_rounds: number; current_round: number; state: string }[];
  activity?: { id: string; event: string; actor_alias: string; created_at: string; task_id?: string | null; detail?: Record<string, unknown> }[];
  template?: { key: string; version: number; name: string; params: Record<string, unknown>; removed: string[] } | null;
  dry_run?: boolean; stalled?: { since: string; days: number } | null; semantics_version?: number;
  capability?: { workflow_human_write?: boolean; reason?: string | null };
}

export interface ProofStep {
  task_id: string; title: string; platform: string | null; scope: "subset" | "full" | null; kind: string | null; status: string; word: string;
  outcome: string | null; rounds: number; build: StepSpec["build"]; counts: { passed: number; failed: number; blocked: number; skipped: number };
  failures: { title: string; verdict: string; reason: string; severity?: string; frame_ids?: string[] }[];
  scenarios: { name: string; verdict: string; note?: string | null; frame_ids: string[] }[];
  frames: { id: string; caption: string }[]; request_id: string | null; summary: string | null; dry_run: boolean;
}
export interface Proof {
  workflow_id: string; gate_task_id: string | null; title: string; dry_run: boolean; params: Record<string, unknown>;
  platforms: { platform: string; word: string; steps: ProofStep[]; headline: string; totals: ProofStep["counts"];
    coverage: { platform: string; validated: number; shared?: number; draft: number; paused: number; threshold: number; warn: boolean } | null; checked: boolean }[];
  findings: { items: { id: string; title: string; severity: string; state: string; fixed_ref?: string | null; frame_ids: string[]; platform?: string | null }[]; tally: Record<string, number> };
  unit_only: { task_id: string; title: string }[];
  watches: (NonNullable<FlowTask["watch"]> & { task_id: string; title: string; platforms: string[] })[];
  decisions: { task_id: string | null; event: string; by: string; at: string; detail: Record<string, unknown> }[];
  warnings: string[]; changed_since_last: { task_id: string; title: string; outcome?: string }[]; commits: string[]; digest: string;
}

/* ---- words ---------------------------------------------------------------------- */

export const KIND_WORD: Record<StepKind, string> = { agent: "Agent", person: "Person", qa: "QA", watch: "Watch", gate: "Gate" };
export const PLATFORM_WORD: Record<string, string> = { ios: "iOS", android: "Android", web: "Web", api: "API" };

export function kindOf(t: FlowTask): StepKind {
  return t.step?.kind ?? (t.qa ? "qa" : "agent");
}

export type StepState = "waiting" | "ready" | "running" | "review" | "asking" | "done" | "failed" | "skipped";

/** One word for where a step is, from the person's side. */
export function stateOf(t: FlowTask): StepState {
  if (t.withdrawn_at || t.route_state === "not_selected" || t.status === "cancelled") return "skipped";
  if (t.awaiting_loop_decision) return "asking";
  if (t.status === "completed") {
    const o = t.reported_outcome?.outcome;
    const kind = t.outcomes.find((x) => x.name === o)?.kind;
    return kind === "failure" && t.routes.find((r) => r.outcome === o)?.destination !== "next" ? "failed" : "done";
  }
  if (t.status === "in_progress") return "running";
  if (t.status === "needs_verification") return "review";
  if (t.status === "ready" && t.watch?.needs_owner) return "asking";
  if (t.status === "ready") {
    const kind = kindOf(t);
    // Only a watch runs on its own; any other step is ready until its agent picks it up (in_progress).
    return kind === "person" || kind === "gate" ? "asking" : kind === "watch" ? "running" : "ready";
  }
  return "waiting";
}

export const STATE_WORD: Record<StepState, string> = {
  waiting: "Not yet", ready: "Ready", running: "Running", review: "In review", asking: "Waiting for you",
  done: "Done", failed: "Failed", skipped: "Skipped",
};

export function watchWord(state: string | null | undefined): string {
  if (!state) return "Not read yet";
  const s = state.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

export function clock(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function elapsed(fromIso: string | null | undefined, now = Date.now()): string {
  if (!fromIso) return "";
  const s = Math.max(0, Math.round((now - Date.parse(fromIso)) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Words for outcomes a person picks on a card. */
export const OUTCOME_WORD: Record<string, string> = {
  resubmit: "Fix and resubmit", live: "It's live", approved: "It was approved", rejected: "It was rejected",
  halted: "It was halted", released: "I released it", valid: "It's valid", invalid: "It's invalid",
};
export const outcomeWord = (name: string) => OUTCOME_WORD[name] ?? name.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
