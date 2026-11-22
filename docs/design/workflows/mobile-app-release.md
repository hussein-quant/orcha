# Mobile App Release: what shipped, the contracts, and what is deferred

Branch `feat/mobile-release-template` (from `origin/main` 1ad8ce3b). Brief: nyumba-connect
`docs/embodent/mobile-release-template-brief.md`. Rule kept throughout: **the workflow engine's logic is
unchanged**. Templates compile to an ordinary `WorkflowCreate` (semantics v2), and the new step kinds finish
through the engine's own outside-result path, so routes, loops, history, acceptance and the finish check behave
exactly as before. Migration 102 / SQLite 032 is additive only.

## Decisions on the brief's open questions (§9)
1. Ported into Embodent only (`frontend/src/pages/flow/`), no shared package yet.
2. The name stays **Workflows**.
3. Gates are clicked. Voice approval through Talk is deferred (Talk #409 is not on main).
4. The coverage warning is a **count of validated scenarios per platform** (`coverage_threshold`, default 10).

## Where things live
| What | Where |
|---|---|
| Template (code, the source of truth) | `portal_backend/workflow_templates.py` → `mobile_app_release()` |
| Template (JSON snapshot) | `docs/design/workflows/mobile-app-release.template.json`; live: `GET /api/containers/{cid}/workflow-templates/mobile_app_release/export` |
| Person / gate / watch steps, dry runs, stalls, redaction | `portal_backend/workflow_steps.py` |
| Proof pack and release page read model | `portal_backend/workflow_proof.py` |
| Endpoints | `portal_backend/workflow_release_routes.py` |
| UI | `frontend/src/pages/flow/` (Board, Gallery, Editor, Run, kit, motion, flow.css) |
| Tests | `tests/test_workflow_release_template.py`, `frontend/src/pages/flow/flow.test.tsx` |

## The compiled shape (why it looks the way it does)
The engine allows at most 3 prerequisites per step and loops of 2 to 10 steps that never overlap, and only a
loop's review step can send work back. The template is built to fit those rules:
- **Fix loop** (max 3): implement → review_merge → staging deploys → QA subset per platform → **triage** (review). `fix` returns to implement.
- **Regression loop** (max 2): bump → QA builds → full regression per platform → **triage** (review). `fix` returns to bump: "fix what the regression found, then bump".
- **Approval loop** (max 3): release builds → processing watch → owner tests → **gate** (review). Send back returns to any step in this loop.
- The release builds are made **after** the regression passes, from that commit. The full regression runs on debug builds of the same commit (release builds block screenshots).
- Removing a step reconnects its dependents to its own prerequisites (with a transitive reduction). A loop without its review step dissolves. A gate without a loop loses Send back. Removing a platform removes its steps.
- Required steps: bump, implement, and (whenever a ship step remains) the full regression per platform, its triage and the gate.

## Step spec (`NewTask.step`, optional)
`{kind: agent|person|qa|watch|gate, key, stage, stage_title, role, person_id, required, platforms[], irreversible,
outward, resources[], watch?, gate?, scope: subset|full, build?: {type, version, build, commit, env},
coverage_threshold, dry_run?: {outcomes[], note}, secrets[]}`. A step without `step` is a classic step.
- **person / gate / watch** steps take no agent: `assign()` refuses one (422 `person_step`), and an agent can never accept one (403).
- **irreversible** steps need a gate upstream (create and preview refuse otherwise: 422 `irreversible_without_gate`). They can't start until that gate was accepted in the **current** work revision (blocker `gate_required`). A send-back reopens the gate, so a go never carries over.

## Watch steps (§4.2)
- The adapter is `watch.adapter.command` (run with `shlex.split`, no shell, cwd = project root, 120 s timeout, the portal's environment, so secret *names* resolve there) or `watch.adapter.http` (GET).
- stdout is the §4.2 JSON; the last `{…}` in stdout is read: `{"state", "terminal", "summary", "detail_url", "observed_at", "data"}`.
- `state_map` turns a state into an outcome; any other state keeps watching. `unknown`, a failure or a non-zero exit is recorded honestly as `unknown` with the error.
- The schedule is `interval_s × backoff^(n-1)`, capped at `max_interval_s`. After `timeout_h` with no mapped state, readings stop and the person resolves it.
- Every reading is kept in `workflow_watch_observations` and shown as a timeline. Readings never hold an agent or a device.
- Nyumbani: the template's commands are `{asc_status_command} --what build|review --version {version} [--build {build}]` and `{play_status_command} --track production --version-code {build}`. The defaults are `python3 scripts/release-adapters/asc_status.py` and `…/play_status.py`; both are parameters (advanced, in the editor).
- A background thread in the portal runs the readings: `workflow_steps.start_driver`, every 2 s. Turn it off with `ORCHA_WORKFLOW_DRIVER=0`.

## API
| Method and path | What |
|---|---|
| `GET /api/containers/{cid}/workflow-templates` | built-ins (Mobile App Release first, plus the QA presets) and project copies |
| `GET …/workflow-templates/{key}` / `…/export` | one template / as a JSON download |
| `POST …/workflow-templates/{key}/compile` `{params, removed[], added[], roles{}, dry_run}` | the live check: `{draft, steps, stages, loops, problems[], ready}` |
| `POST /api/containers/{cid}/workflow-templates` `{template}` or `{from_key, key, name, params, removed, added, roles}` | import, or save a project copy (versioned; remembers its base) |
| `POST /api/containers/{cid}/workflows/from-template` `{key, params, removed, added, roles, dry_run, start, idempotency_key}` | create and (by default) Start |
| `POST /api/workflows/{wid}/launch` (Mutation) | one Start for any workflow: prepare what isn't, then Start |
| `POST /api/workflows/{wid}/steps/{tid}/decide` `{choice: go\|no_go\|send_back, reason, send_back_to, proof_digest}` or `{outcome, reason}` | a gate or person decision; reason required for No-go and Send back; also written to `decisions` (`subject_type=workflow_gate`) |
| `POST /api/workflows/{wid}/steps/{tid}/check-now` | read a watch status now |
| `POST /api/workflows/{wid}/steps/{tid}/resolve` `{state}` | resolve a watch by hand ("I see it's live") |
| `GET /api/workflows/{wid}/proof[?step=<gate id>]` | the proof pack / release page read model (digest included) |
| `GET /api/containers/{cid}/workflow-board` | the home list: thread, waiting for you, stage, stalled first |
| `POST /api/workflows/{wid}/snooze` `{days}` / `POST /api/workflows/{wid}/close` `{note}` | quiet a stall / accept the goal and finish, as one |
| `GET /api/workflows/{wid}/next-release` | "Run again": same template, build + 1, release type asked again |
| `PATCH /api/qa/findings/{fid}` `{action: mark_fixed, fixed_ref}` / `{action: mark_verified}` | finding lifecycle beside its status |
| existing `POST /api/workflows/{wid}/decisions` | a store `rejected` → owner decides (`pick_outcome` live, or `stop`) |

## Dry run
`dry_run: true` assigns nothing, so no agent ever wakes. Agent and QA steps report canned results after about 4 s (`ORCHA_DRY_RUN_DELAY_S`), following `step.dry_run.outcomes` per round. Watch steps play `watch.dry_run_states`. The template's script covers one fix loop (QA subset fails, then passes), a store rejection on iOS (the owner decides), and "unknown" on Google Play. People decide every person step and gate. Coverage in the proof is the project's real Quality data.

## Done and deferred, against the brief
- **§3 template**: done. 31 steps in 12 stages: the brief's 11 stages, with release builds split into "Version and QA builds" and "Release builds". Implement is one step for the whole batch (one PR per item inside it); fanning out one step per item is deferred.
- **§3.1 mechanics**: library, parameters, remove with locks, project copies, import/export and run again are done. Offering a template update as a diff is deferred: the list flags `update_available` only.
- **§4.1 person steps and gates**: done. Notifications use the existing workflow events. Voice through Talk is deferred.
- **§4.2 watch steps**: done.
- **§4.3 proof pack and release page**: done (the run page). A shareable read-only link and a PDF/zip export for the whole workflow are deferred.
- **§4.4 QA honesty**:
  - Done:
    - Scope (subset/full) and the build under test on QA steps, shown in the proof.
    - A warning when QA ran on more than one commit.
    - Latest-round headlines in the proof.
    - The finding lifecycle API (`mark_fixed` / `mark_verified`).
    - Coverage meters.
  - Deferred:
    - "Changed screens" derived from PRs.
    - A "mark verified" prompt on a passing re-run in the Quality tab.
    - The Quality tab's own run headline.
    - Labelling ad hoc QA sessions.
- **§4.5 template library**: done. The QA presets appear as templates. A per-step block editor inside the template is deferred.
- **§4.6 machine scheduling**: partial. Steps declare resource classes, and the engine already runs exclusive worker turns (dependent steps take a turn alone), so builds and device QA in one release don't overlap. A host-level scheduler across workflows and device locks shown in the UI are deferred.
- **§4.7 stalled workflows**: done. Flagged after `ORCHA_WORKFLOW_STALL_DAYS` (default 3), sorted first, with one event to the owner (`workflow_stalled`) and snooze. Resume and cancel are on the run page.
- **§4.8 secrets and safety rails**: done. Secret names only, redaction of tokens (Sanctum `id|secret`, JWT, keys) in step narratives and watch readings, and irreversible steps gated per run. Redaction of existing evidence uploads is unchanged.
- **§5 contracts**: done as above. The gate spec is `{proof_steps, include_unit_only, include_metadata_diff, choices, require_reason}`. The metadata diff isn't assembled yet.
- **§6 UI**:
  - Done:
    - Board, gallery with hover-play, editor (one line, waypoints, remove switches with locks, branches, loop brackets, step picker, 600 ms live check, one Start), and the run page.
    - Run page parts: Orb, stage circuit with wire fill and pulse, step rail with inline detail, gate card with the proof pack (count-up figures, stamps, filmstrip and lightbox, coverage meters), watch timeline, round chips, decision cards and Close.
    - Live-moments-only animation, reduced motion, and aria-live announcements.
    - The classic screens at `?classic=1`.
    - A blank workflow opens the composer (`/workflows/new?blank=1`, `frontend/src/pages/flow/Composer.tsx`): the name and goal as a title, steps on the same line, Enter adds a step that waits for the one before, "Paste a plan" turns lines into chained steps, drag or arrow keys reorder, prerequisites as chips (max 3, cycles refused), outcomes and where they go, loops with a bracket on the line, objectives, existing tasks, and a live check. It runs the classic draft, `draftProblems`, Preview and Create (with the preview digest and the same idempotent operation) unchanged; "Save and start" is Create then `/launch`. The draft is also kept on this device per project and person.
    - `?addTask=` links (add a task to a workflow) still open the classic page, which owns that flow.
  - Deferred:
    - Drag reorder in the editor (the hook is ported, `useReorder`, but not wired).
    - The read-only Graph toggle (the classic Route tab has it).
- **§7 acceptance**: the dry run was walked end to end in the browser, including a fail → triage → fix → pass loop, a gate send back, a store rejection the owner decided, Go and Close. The same path is an API test. An automated browser e2e test is deferred.
