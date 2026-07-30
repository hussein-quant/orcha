# Sandbox mode

Sandbox mode runs agent wakes inside a disposable, resource-capped Docker
container instead of as a raw process on the notifier's host. The agent can no
longer read `~/.ssh`, browser profiles, or unrelated repos on the machine
running `orcha` — its filesystem view is only its own workspace (plus a
read-only api-config mount). On the network it keeps ordinary outbound access
(for the LLM provider API) and joins the stack's compose network to reach the
portal; restricting network egress is a tracked follow-up, not yet shipped.
Sandbox runs survive a notifier restart (the daemon re-adopts them via the
container name recorded on the run row instead of orphaning them), so closing
the laptop or running `orcha update` no longer kills in-flight work. Sandbox mode is
**opt-in per workspace** — host mode (a plain `claude -p` / `codex exec`
process, unchanged) remains the default.

## Enabling it

```bash
orcha sandbox status         # show the effective config (defaults filled in)
orcha sandbox on             # flip sandbox.enabled = true in .claude/orcha.json
orcha sandbox off            # flip it back
```

`on`/`off` do a read-modify-write of `.claude/orcha.json` — every other
top-level key, and any sandbox sub-keys you've already set (a custom `image`,
`memory`, and so on), are preserved untouched.

Sandbox mode needs three things present before wakes will succeed:

1. **Docker running** and reachable on the host (or VM) the notifier runs on.
2. **A provider API key in the daemon's environment.** The container receives
   credentials ONLY via env passthrough from the process that starts the
   notifier daemon (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or
   `ORCHA_LLM_API_KEY`) — host OAuth login state (`claude login` /
   `codex login`) does **not** reach the container. Export the key in the
   environment that starts the daemon, or sandbox wakes will fail auth.
   `orcha sandbox status` warns when none of the three is set.
3. **The runner image present** — either build it locally:

   ```bash
   orcha sandbox build-image
   ```

   which builds `orcha/runner:0.5` from the CLI's installed template (no
   project directory required), or pull the published image once it's
   available in a registry:

   ```bash
   docker pull orcha/runner:0.5
   ```

## Config reference

All keys live under the `sandbox` block in `.claude/orcha.json`. Unset keys
fall back to the defaults below; `orcha sandbox status` always prints the
effective (defaults-filled-in) config.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Master switch. `false` = host mode, unchanged. |
| `image` | `orcha/runner:0.5` | The Docker image each wake runs. |
| `memory` | `4g` | `docker run --memory` cap per container. |
| `cpus` | `2` | `docker run --cpus` cap per container. |
| `pids_limit` | `512` | `docker run --pids-limit` cap per container. |
| `max_runtime_secs` | `7200` (2h) | Wall-clock deadline; the reaper `docker stop`s a container still running past it. |
| `network` | *(derived)* | Docker network to attach the container to. If unset, derived as `<compose-name>_default` from `.orcha/docker-compose.yml`'s `name:` line — i.e. the stack's own compose network. Set explicitly only to override that. |

## How it works

Each wake becomes one `docker run` instead of one host `Popen`:

- The container is named `orcha-run-<12 hex chars>` and labeled
  `orcha.managed=1`, `orcha.container_name=<name>`, and
  `orcha.cid=<current_container_id>` (the project's own container id from
  `.claude/orcha.json`) — the labels the reaper uses to find, adopt, and
  scope-limit its sweeps to *this* project's containers, even on a host
  running several Orcha stacks side by side.
- The project's workspace is bind-mounted at `/workspace`, and the container's
  working directory is set there — the same repo checkout and build caches a
  host-mode wake would use, so nothing is re-cloned between wakes.
- A sandbox-scoped copy of `.claude/orcha.json` (with `api_base_url` rewritten
  to `http://portal:8000`) is bind-mounted read-only over the workspace's own
  copy at `/workspace/.claude/orcha.json`. The host's copy points at
  `localhost:<port>`, which is unreachable from inside a container, so this
  override is what lets the orcha skills (curl/Bash calls to the API) work
  unmodified.
- The container joins the stack's compose network (`network`, above, unless
  overridden), so those same skill calls resolve `http://portal:8000` to the
  real portal service — no host networking, no published ports needed.
- Secrets and identity (`ORCHA_ALIAS`, `ORCHA_RUN_TOKEN`, `ANTHROPIC_API_KEY`,
  etc.) ride the **client process's environment** via `docker run -e KEY`
  (docker inherits the value from the process invoking it) — they are never
  written into argv, so they never show up in `ps` output on the host.

**The hard rule:** if Docker is unavailable, the runner image is missing, or
disk is low, the wake **fails loudly with a visible reason**. There is no
fallback path that quietly runs the wake on the host instead — de-sandboxing
is never something that happens silently on your behalf.

## Failure modes

| Situation | What happens |
|---|---|
| Docker daemon down / not installed | Preflight fails before the container starts; the wake fails with that reason surfaced (never falls back to host mode). |
| Runner image missing | Preflight fails with `runner image <image> not present — run \`docker pull <image>\` (or \`orcha sandbox build-image\`)`. |
| Disk low (< 5 GiB free on the workspace volume) | Preflight fails with an insufficient-disk reason before spawning. |
| Out of memory | Docker OOM-kills the container; the reaper reads `OOMKilled` from `docker inspect` and stamps the run `killed` with reason "out of memory — raise sandbox.memory". |
| Past its runtime deadline | A container still `running` older than `max_runtime_secs` gets `docker stop`'d by the reaper; the *next* sweep stamps the run from its real exit code once it has actually exited. |
| Orphaned container | A live, managed container with no open `worker_runs` row referencing it gets stopped (never removed) by the reaper's per-sweep orphan pass — scoped to this project's `orcha.cid` label, so it never touches another stack's containers on the same host. |
| Notifier/daemon restart mid-run | The sweep treats a live container whose row is still `running` as **adopted**, not orphaned — it is left alone and reconciled from its real state on a later sweep. Runs are never killed just because the daemon that spawned them restarted. |
| Docker daemon itself unreachable during a sweep | The sweep reconciles nothing that tick (no probes, no finishes, no stops) — an unreachable daemon is treated as "unknown", not "everything's gone", so it can never mass-kill in-flight runs. |
| Workspace volumes | Never auto-deleted, in any of the above. A stopped/removed container's workspace persists so its state survives the reap. |

## Notes

- **Containers run as root** inside the sandbox. On Linux hosts this means
  files the agent creates in the workspace are root-owned on the host
  filesystem. UID-mapping so workspace files come back owned by your normal
  user is a tracked follow-up, not yet shipped.
- **The runner image bundles the latest Claude Code and Codex CLIs as of
  build time** (`npm install -g @anthropic-ai/claude-code @openai/codex` in
  the Dockerfile) — it does not auto-update. Re-run `orcha sandbox
  build-image` (or re-pull the published tag) to refresh them.
- **Durability**: because a sandbox run is reconciled from its recorded
  container name on the run row rather than from a live process handle, a
  notifier restart re-adopts every live sandbox run it finds — nothing needs
  to be resumed manually. (The `orcha.*` labels serve the orphan pass: finding
  live containers no open run row references.)
