import { useEffect, useRef, useState } from 'react'
import type { InstallProgress, PreflightReport, PrereqProbe } from '../../../../shared/types'
import { Check, Copy, ExternalLink, RotateCw } from 'lucide-react'
import { InlineText, Notice, ObButton, StatusGlyph, StepFooter, StepHeader, type GlyphState } from '../ui'

const LINKS = {
  homebrew: 'https://brew.sh',
  docker: 'https://www.docker.com/products/docker-desktop/',
  claudeCodeDocs: 'https://docs.anthropic.com/en/docs/claude-code/setup',
  codexDocs: 'https://developers.openai.com/codex/cli'
}

const AI_COMMANDS = [
  {
    name: 'Claude Code',
    cmd: 'npm install -g @anthropic-ai/claude-code',
    doc: LINKS.claudeCodeDocs
  },
  { name: 'Codex', cmd: 'npm install -g @openai/codex', doc: LINKS.codexDocs }
]

/** After this long, a still-pending check explains itself (preflight may be starting
 *  Docker, which can take up to a minute). */
const SLOW_MS = 6000

/** After this long without an answer, Docker is treated as not responding: the row says so,
 *  counts the wait honestly and offers what to do. Preflight keeps waiting in the background
 *  (it may be starting Docker, up to about a minute), so the row still turns green by itself
 *  if Docker comes up. */
const STUCK_MS = 15000

const UNRESPONSIVE_HINT =
  'Docker isn’t responding. Quit and reopen Docker Desktop (or choose Restart from its menu), then re-check.'

/** One CLI install line: a copy-able command and a docs link. */
function CommandLine({ name, cmd, doc }: { name: string; cmd: string; doc: string }) {
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
    void navigator.clipboard?.writeText(cmd).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <div className="flex items-center gap-2">
      <span className="w-[84px] shrink-0 text-xs text-text-3">{name}</span>
      <code className="ob-code min-w-0 flex-1 truncate py-1" title={cmd}>
        {cmd}
      </code>
      <button type="button" className="ob-link" aria-label={`Copy the ${name} install command`} onClick={copy}>
        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        {copied ? 'Copied' : 'Copy'}
      </button>
      <button
        type="button"
        className="ob-disclosure"
        aria-label={`${name} docs`}
        onClick={() => void window.orchaDesktop.openExternal(doc)}
      >
        Docs <ExternalLink className="h-3 w-3" />
      </button>
    </div>
  )
}

function ExternalAction({ label, url }: { label: string; url: string }) {
  return (
    <button type="button" className="ob-link" onClick={() => void window.orchaDesktop.openExternal(url)}>
      {label} <ExternalLink className="h-3 w-3" />
    </button>
  )
}

interface Row {
  key: string
  label: string
  glyph: GlyphState
  aside: string
  action?: React.ReactNode
  extra?: React.ReactNode
}

/** Setup: checks what Orcha needs on this Mac (Docker running, Homebrew, an AI coding CLI,
 *  and the Orcha helper, which is the one thing Orcha installs itself — on Continue). Every
 *  row says its real state and offers the action that fits THAT state. */
export default function PreflightStep({ onContinue }: { onContinue: () => void }) {
  const [report, setReport] = useState<PreflightReport | null>(null)
  const [probe, setProbe] = useState<PrereqProbe | null>(null)
  const [checking, setChecking] = useState(true)
  const [probeLoading, setProbeLoading] = useState(true)
  const [slow, setSlow] = useState(false)
  const [stuck, setStuck] = useState(false)
  const [waitedS, setWaitedS] = useState(0)
  const [checkError, setCheckError] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [lastLine, setLastLine] = useState('')
  const [installError, setInstallError] = useState<string | null>(null)
  const generation = useRef(0)

  const check = (): void => {
    const gen = ++generation.current
    setChecking(true)
    setSlow(false)
    setStuck(false)
    setWaitedS(0)
    setCheckError(false)
    setInstallError(null)
    const started = Date.now()
    const slowTimer = setTimeout(() => gen === generation.current && setSlow(true), SLOW_MS)
    const tick = setInterval(() => {
      if (gen !== generation.current) return clearInterval(tick)
      const ms = Date.now() - started
      setWaitedS(Math.floor(ms / 1000))
      if (ms >= STUCK_MS) setStuck(true)
    }, 1000)
    setProbeLoading(true)
    setReport(null)
    // The two checks resolve independently: the tool probe is instant, while preflight may
    // spend up to a minute starting Docker — rows fill in as soon as their own answer lands.
    const probeP = window.orchaDesktop.probePrereqs().then((p) => {
      if (gen === generation.current) {
        setProbe(p)
        setProbeLoading(false)
      }
    })
    const reportP = window.orchaDesktop
      .preflight()
      .then((r) => {
        if (gen === generation.current) setReport(r)
      })
      .finally(() => clearInterval(tick))
    Promise.all([probeP, reportP])
      .catch(() => {
        if (gen === generation.current) setCheckError(true)
      })
      .finally(() => {
        clearTimeout(slowTimer)
        clearInterval(tick)
        if (gen === generation.current) {
          setChecking(false)
          setProbeLoading(false)
          setSlow(false)
          setStuck(false)
        }
      })
  }
  useEffect(() => {
    check()
    return () => {
      generation.current += 1
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(
    () =>
      window.orchaDesktop.onInstallProgress((e: InstallProgress) => {
        if (e.status === 'log') setLastLine(e.line)
      }),
    []
  )

  const dockerOk = report?.docker === 'ok'
  const aiOk = !!probe && (probe.claude || probe.codex)
  const brewOk = !!probe?.homebrew
  const ready = !!probe && !!report && dockerOk && aiOk && brewOk

  async function continueOn(): Promise<void> {
    if (probe?.orcha) return onContinue()
    setInstalling(true)
    setInstallError(null)
    setLastLine('')
    try {
      const res = await window.orchaDesktop.installPrereqs()
      if (!res.ok) {
        setInstallError(`The Orcha helper didn’t install: ${res.detail}`)
        return
      }
      onContinue()
    } catch {
      setInstallError('The Orcha helper didn’t install. Check your connection and try again.')
    } finally {
      setInstalling(false)
    }
  }

  const pending = checking && (!probe || !report)
  const dockerPending = !report
  const probePending = probeLoading || !probe
  const pendingRow = (key: string, label: string, aside = 'Checking…'): Row => ({ key, label, glyph: 'running', aside })

  const dockerRow: Row = dockerPending
    ? stuck
      ? {
          key: 'docker',
          label: 'Docker',
          glyph: 'warning',
          aside: `Not responding · ${waitedS}s`,
          extra: (
            <span className="ob-row-sub" data-testid="docker-stuck">
              Docker hasn’t answered yet. If Docker Desktop looks frozen, quit it from the menu bar and open it
              again, or Re-check. Quorate keeps waiting and updates this row by itself once Docker answers.
            </span>
          )
        }
      : pendingRow('docker', 'Docker', slow ? 'Waiting for Docker…' : 'Checking…')
    : report?.docker === 'ok'
      ? {
          key: 'docker',
          label: 'Docker',
          glyph: 'done',
          aside: report.autoStarted ? 'Started' : 'Running'
        }
      : report?.docker === 'not-installed'
        ? {
            key: 'docker',
            label: 'Docker',
            glyph: 'todo',
            aside: 'Not installed',
            action: <ExternalAction label="Get Docker" url={LINKS.docker} />,
            extra: (
              <span className="ob-row-sub">
                Docker Desktop, OrbStack or Colima all work. Install one, start it, then re-check.
              </span>
            )
          }
        : report?.unresponsive
          ? {
              // Docker is installed but its CLI stopped answering: starting it again won't
              // help, so there's no "Start Docker" link here — only the restart advice.
              key: 'docker',
              label: 'Docker',
              glyph: 'warning',
              aside: 'Not responding',
              extra: (
                <span className="ob-row-sub" data-testid="docker-unresponsive">
                  <InlineText text={report.hint ?? UNRESPONSIVE_HINT} />
                </span>
              )
            }
          : {
            key: 'docker',
            label: 'Docker',
            glyph: 'warning',
            aside: report?.docker === 'app-translocated' ? 'Can’t start' : 'Not running',
            action: (
              <button type="button" className="ob-link" onClick={check} disabled={checking}>
                <RotateCw className="h-3 w-3" /> Start Docker
              </button>
            ),
            extra: report?.hint ? (
              <span className="ob-row-sub">
                <InlineText text={report.hint} />
              </span>
            ) : undefined
          }

  const brewRow: Row = probePending
    ? pendingRow('homebrew', 'Homebrew')
    : brewOk
      ? {
          key: 'homebrew',
          label: 'Homebrew',
          glyph: 'done',
          aside: 'Installed'
        }
      : {
          key: 'homebrew',
          label: 'Homebrew',
          glyph: 'todo',
          aside: 'Not found',
          action: <ExternalAction label="Get Homebrew" url={LINKS.homebrew} />
        }

  const aiRow: Row = probePending
    ? pendingRow('ai', 'AI coding agent')
    : aiOk
      ? {
          key: 'ai',
          label: 'AI coding agent',
          glyph: 'done',
          aside: probe!.claude && probe!.codex ? 'Claude Code, Codex' : probe!.claude ? 'Claude Code' : 'Codex'
        }
      : {
          key: 'ai',
          label: 'AI coding agent',
          glyph: 'todo',
          aside: 'Not found',
          extra: (
            <>
              <span className="ob-row-sub">Install Claude Code or Codex in Terminal, then re-check:</span>
              {AI_COMMANDS.map((c) => (
                <CommandLine key={c.name} {...c} />
              ))}
            </>
          )
        }

  const helperRow: Row = probePending
    ? pendingRow('orcha', 'Orcha helper')
    : installing
      ? {
          key: 'orcha',
          label: 'Orcha helper',
          glyph: 'running',
          aside: 'Installing…',
          extra: lastLine ? (
            <span className="truncate font-mono text-[11.5px] text-text-3" title={lastLine}>
              {lastLine}
            </span>
          ) : undefined
        }
      : probe?.orcha
        ? {
            key: 'orcha',
            label: 'Orcha helper',
            glyph: 'done',
            aside: 'Installed'
          }
        : {
            key: 'orcha',
            label: 'Orcha helper',
            glyph: installError ? 'failed' : 'todo',
            aside: installError ? 'Didn’t install' : 'Installs when you continue'
          }

  const rows = [dockerRow, brewRow, aiRow, helperRow]

  return (
    <>
      <StepHeader
        title="Check your Mac"
        subtitle="Quorate runs your agents with a few free tools. Anything missing is listed with how to get it."
      />

      {checkError ? (
        <Notice tone="danger" title="Couldn’t check this Mac" action={<ObButton onClick={check}>Re-check</ObButton>}>
          The check didn’t finish. If Docker is starting or busy, wait a moment and re-check.
        </Notice>
      ) : (
        <div className="ob-list" aria-busy={pending}>
          {rows.map((r) => (
            <div key={r.key} className="flex flex-col" data-row={r.key}>
              <div className="ob-row">
                <StatusGlyph state={r.glyph} />
                <span className="ob-row-title flex-1">{r.label}</span>
                {r.action}
                <span className="ob-row-aside">{r.aside}</span>
              </div>
              {r.extra && <div className="ob-row-extra">{r.extra}</div>}
            </div>
          ))}
        </div>
      )}

      {installError && <Notice tone="danger" title={installError} />}

      <StepFooter
        left={
          <ObButton variant="ghost" disabled={(checking && !slow) || installing} onClick={check}>
            Re-check
          </ObButton>
        }
        hint={
          pending || ready || checkError
            ? undefined
            : brewOk && aiOk && report?.unresponsive
              ? 'Restart Docker, then re-check'
              : brewOk && aiOk && report?.docker !== 'not-installed'
                ? 'Start Docker, then re-check'
              : 'Install what’s missing, then re-check'
        }
      >
        <ObButton
          variant="primary"
          data-onb-primary="true"
          disabled={!ready || checking || installing}
          onClick={() => void continueOn()}
        >
          {installing ? 'Installing…' : installError ? 'Try again' : 'Continue'}
        </ObButton>
      </StepFooter>
    </>
  )
}
