# Talk to Orcha: setup and dependencies (GH #409)

Talk is the master chat in the Embodent Mac app. It covers every running project, by typing or
by voice. Use this page to install what it needs on a new Mac, and to check it when something
doesn't work.

| Part | Needed for | Where it runs |
|---|---|---|
| Embodent desktop app | Talk itself | this Mac |
| `orcha` CLI, projects upgraded | project data, drafts, actions | each project's portal |
| Claude Code (`claude`), signed in | Talk's brain (`claude -p`, no tools) | this Mac, your own account |
| Local speech (`orcha voice install`) | voice only: listening and speaking | one loopback service on this Mac |
| Homebrew `espeak-ng` | the Kokoro voice | this Mac |

Typing works with the first three. Voice also needs the last two.

## 1. Requirements

- A Mac with Apple Silicon (M1 or later). Local speech uses MLX, which only runs on Apple Silicon.
- About 3 GB free for the speech models: Parakeet is about 2.5 GB and Kokoro about 0.4 GB.
- [Homebrew](https://brew.sh), [uv](https://docs.astral.sh/uv/), and Node.js with npm to run the desktop app from source.

## 2. The `orcha` CLI and your projects

Install or update the CLI from this repository, then upgrade each project. The upgrade brings
in the Talk routes (`/api/containers/{cid}/voice-first/*`) and migration 092 (`voice_actions`).

```bash
uv tool install --force --reinstall --no-cache ./orcha-cli

# in each project folder (back up first)
orcha backup && orcha upgrade
```

To restart a project, use `orcha up`. Never use `orcha init --force` or `orcha down -v`.

Check: `GET http://localhost:<port>/api/containers/<cid>/voice-first/context` returns the team,
open tasks and what needs you. The routes are listed in `/openapi.json`.

## 3. Claude Code

Talk's brain is your own Claude Code, run headless with no tools. It only sees project
summaries and what it asks to look up, read-only. It can propose one action at a time, and
nothing runs until you confirm the draft.

```bash
npm install -g @anthropic-ai/claude-code   # or your usual install
claude                                      # sign in once
```

Embodent finds `claude` on your PATH, the same way it detects agent CLIs. The model defaults to
Sonnet. To change it, set `ORCHA_TALK_MODEL` in the environment Embodent starts from.

If you see "Claude Code is not installed on this Mac", `claude` isn't on the PATH that Embodent
sees.

## 4. Local speech (voice only)

The easy way: turn voice on in Talk (the **Voice** button, holding Space, or ⌃⌥Space). If speech
isn't set up yet, Talk says what it needs and asks first. Press **Install** and it runs
`orcha voice install` for you, showing progress, then turns voice on. Nothing is downloaded
unless you press Install.

To do it by hand instead:

```bash
brew install espeak-ng      # free, ~26 MB; Kokoro uses it for words it doesn't know
orcha voice install         # once: Python env, MLX speech, Parakeet + Kokoro models
orcha voice status          # what is installed and running
```

- `orcha voice install --model whisper-turbo` picks a smaller speech model (about 1.6 GB) instead
  of Parakeet.
- Everything lives in `~/.orcha/voice`, or in `ORCHA_VOICE_HOME` if you set it:
  - its own `venv`: `mlx-audio==0.6.3`, `misaki[en]==0.9.4` and the spaCy `en_core_web_sm` model
  - `models/`: the Hugging Face cache
  - `config.json`
  - `token`: the shared secret the service checks
- The service listens only on `127.0.0.1:8790` and runs with the Hugging Face hub offline, so
  no audio leaves the Mac. Embodent starts it when you use voice, and it stops itself after a
  while with no requests.
- If `espeak-ng` is missing, Talk falls back to the built-in Mac voices. You can also pick a
  voice and speed in Settings › Voice › Talk to Orcha.
- The first time you use voice, macOS asks you to allow Embodent to use the microphone.
- To remove it: `orcha voice uninstall`, or `orcha voice uninstall --models-only` to only free
  the disk space.

## 5. The desktop app (development)

```bash
cd desktop
npm install
npm run dev
```

Talk's chats are stored in SQLite through `node:sqlite`, which is built into the Node that ships
with Electron, so there is nothing extra to install. The file is `~/Library/Application Support/Orcha/talk/talk.db`, with full-text
search and running notes for long chats. Older `conversations.json` files are imported once and
renamed to `.imported`.

## 6. Using it

- Open **Talk** in the sidebar, or press **⌃⌥Space** from any app. Hold **Space** to talk, or
  tap the orb for hands-free.
- New chats cover all projects. The **All projects** menu at the top narrows one chat to one
  project.
- Type **@** to tag a project or an agent. The pick becomes a pill, and a project pill narrows
  the next **@** to that project's agents.
- Every write is a draft card first. You see everything that will be sent, can **Edit** it or
  push back by talking, and nothing runs until you press **Confirm** or say the confirm word.
- Links, agent cards (**Chat**, **Runs**) and workflows open the real project page in the side
  panel (`?panel=1`), without the project's header.

## Troubleshooting

| Symptom | Check |
|---|---|
| A project is missing from Talk | Is it running? Upgraded (`orcha upgrade`)? Its `voice-first/context` must return 200. |
| "I can't reach Claude right now" | Run `claude -p "hi"` in a terminal. Check your sign-in and usage limits. |
| The voice button says speech isn't installed | `orcha voice status`, then `orcha voice install`. |
| Robotic or Mac voice instead of Kokoro | `brew install espeak-ng`, then restart the service: `orcha voice stop` (it starts again on use). |
| Nothing is heard | System Settings › Privacy & Security › Microphone › Embodent. |
| A one-project chat can't see another project | Press **Cover all projects** at the top of the chat. |
