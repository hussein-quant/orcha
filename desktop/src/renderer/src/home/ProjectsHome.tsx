import { useCallback, useEffect, useState } from 'react'
import type { Stack } from '../../../shared/types'
import { loadProjectCards, type ProjectCardData } from './loadProjectCards'
import { loadFavorites, toggleFavorite } from './favorites'
import ProjectCard from './ProjectCard'
import NewProjectCard from './NewProjectCard'
import StoppedStackRow from './StoppedStackRow'
import DockerDownBanner from '../components/DockerDownBanner'

const POLL_MS = 5000

type ViewState =
  | { kind: 'loading' }
  | { kind: 'dockerDown' }
  | { kind: 'ready'; stacks: Stack[]; cards: ProjectCardData[] }

/** The desktop home screen — a project-cards grid styled after the Orcha Cloud web hub's
 *  ProjectsPage (see resources/orcha-templates/portal/frontend/src/cloud/projects/
 *  ProjectsPage.tsx), NOT the old per-stack card/list toggle. One card per container across
 *  every running stack; a stopped stack — which can't list its containers, nothing to fetch
 *  a card from — renders as one muted row instead of a fake card. Favorites (starred cards)
 *  pin to their own section above the rest, persisted in localStorage. Replaces the old
 *  left icon rail entirely: this IS the navigation surface. */
export default function ProjectsHome({ onCreate }: { onCreate: () => void }) {
  const [view, setView] = useState<ViewState>({ kind: 'loading' })
  const [favorites, setFavorites] = useState<Set<string>>(() => loadFavorites(window.localStorage))

  const refresh = useCallback(async () => {
    try {
      const stacks = await window.orchaDesktop.listStacks()
      const cards = await loadProjectCards(stacks, window.orchaDesktop.portalGet)
      setView({ kind: 'ready', stacks, cards })
    } catch {
      setView({ kind: 'dockerDown' })
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(timer)
  }, [refresh])

  function onToggleFavorite(cid: string): void {
    setFavorites(toggleFavorite(window.localStorage, cid))
  }

  function openProject(card: ProjectCardData): void {
    void window.orchaDesktop.portalShow(card.stack.project, `/?cid=${encodeURIComponent(card.container.id)}`)
  }

  function pairProject(card: ProjectCardData): void {
    void window.orchaDesktop.portalShow(
      card.stack.project,
      `/settings?cid=${encodeURIComponent(card.container.id)}#tab=general`
    )
  }

  if (view.kind === 'loading') {
    return (
      <main className="mx-auto flex h-full max-w-5xl flex-col gap-4 p-8 animate-fade-in">
        <div className="text-sm text-text/40">Loading…</div>
      </main>
    )
  }

  if (view.kind === 'dockerDown') {
    return (
      <main className="mx-auto flex h-full max-w-5xl flex-col gap-4 p-8 animate-fade-in">
        <DockerDownBanner />
      </main>
    )
  }

  const { stacks, cards } = view
  const stoppedStacks = stacks.filter((s) => !s.running)
  const favs = cards.filter((c) => favorites.has(c.container.id))
  const rest = cards.filter((c) => !favorites.has(c.container.id))

  const projectCard = (c: ProjectCardData): React.ReactElement => (
    <ProjectCard
      key={c.container.id}
      container={c.container}
      favorited={favorites.has(c.container.id)}
      onToggleFavorite={() => onToggleFavorite(c.container.id)}
      onOpen={() => openProject(c)}
      onPair={() => pairProject(c)}
    />
  )

  return (
    <main className="mx-auto flex h-full max-w-5xl flex-col gap-6 overflow-y-auto p-8 animate-fade-in">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-text">Projects</h1>
        <p className="text-sm text-text/40">Everything on this machine.</p>
      </div>

      {favs.length > 0 && (
        <>
          <SectionLabel>Favorites</SectionLabel>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">{favs.map(projectCard)}</div>
          <SectionLabel>All projects</SectionLabel>
        </>
      )}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {rest.map(projectCard)}
        <NewProjectCard onClick={onCreate} />
      </div>
      {cards.length === 0 && stoppedStacks.length === 0 && (
        <p className="text-sm text-text/40">No projects yet — create one to get started.</p>
      )}

      {stoppedStacks.length > 0 && (
        <div className="flex flex-col gap-2">
          <SectionLabel>Stopped</SectionLabel>
          {stoppedStacks.map((s) => (
            <StoppedStackRow key={s.project} stack={s} onChanged={() => void refresh()} />
          ))}
        </div>
      )}
    </main>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-[11px] font-semibold uppercase tracking-wider text-text/35">{children}</div>
}
