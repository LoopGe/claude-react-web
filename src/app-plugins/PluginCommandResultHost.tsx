// Global renderer for plugin Popover/Dialog command results.
//
// Mounted once at the App root. Subscribes to the commandResults store and
// renders each active result:
//   - Popover: positioned at the invocation anchor (the message element the
//     user gestured at). If the anchor is gone (message virtualised out +
//     TTL expired, or no anchor was provided), it degrades to a centered
//     dialog so the content isn't lost.
//   - Dialog: centered modal with action buttons.
// Notifications don't reach here (they fire toasts directly in
// usePluginCommands).

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { commandResults, type ActiveResult } from './result-store'
import { invocationAnchors } from './invocation-anchor-store'
import { usePluginCommands } from './usePluginCommands'
import { Markdown } from '../components/Markdown'
import { ENTER_TRANSITION, EXIT_TRANSITION, useMotionTransition, usePopoverMotion } from '../utils/transitions'
import type { PluginCommandResult, PluginResultContent } from '../../shared/app-plugins/command-result.js'

export function PluginCommandResultHost() {
  const results = useSyncExternalStore(commandResults.subscribe, commandResults.snapshot, commandResults.snapshot)
  const { execute } = usePluginCommands()
  return (
    <AnimatePresence>
      {results.map((r) => (
        <ResultCard key={r.id} entry={r} execute={execute} />
      ))}
    </AnimatePresence>
  )
}

const ResultCard = memo(function ResultCard({ entry, execute }: { entry: ActiveResult; execute: (opts: never) => void }) {
  if (entry.result.type === 'dialog') {
    return <PluginDialog entry={entry} execute={execute} />
  }
  return <PluginPopover entry={entry} execute={execute} />
})

function PluginPopover({ entry, execute }: { entry: ActiveResult; execute: (opts: never) => void }) {
  const result = entry.result as Extract<PluginCommandResult, { type: 'popover' }>
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const [degraded, setDegraded] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const { popover } = usePopoverMotion()

  // Resolve the anchor on mount AND re-resolve on scroll/resize so the
  // popover tracks the message element as it moves (the anchor store
  // recomputes from the live element). Degrade to a centered card if the
  // anchor is gone.
  useLayoutEffect(() => {
    const reposition = () => {
      const anchor = invocationAnchors.resolve(entry.id)
      if (!anchor) {
        // measured-layout: degrade when anchor missing
        setDegraded(true)
        setPos(null)
        return
      }
      setDegraded(false)
      const el = ref.current
      const w = el?.offsetWidth ?? 320
      const h = el?.offsetHeight ?? 160
      const x = Math.max(8, Math.min(anchor.rect.left, window.innerWidth - w - 8))
      const y = Math.max(8, Math.min(anchor.rect.bottom + 6, window.innerHeight - h - 8))
      // measured-layout: follow anchor on scroll/resize
      setPos({ x, y })
    }
    reposition()
    // Capture-phase scroll so nested scroll containers (Virtuoso) also trigger.
    window.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    return () => {
      window.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
    }
  }, [entry.id])

  const dismiss = () => commandResults.dismiss(entry.id)
  const dismissible = result.dismissible !== false
  const isLoading = entry.id.startsWith('loading-')

  return (
    <motion.div
      ref={ref}
      className="plugin-popover"
      style={pos ? { left: pos.x, top: pos.y } : { left: '50%', top: '40%', transform: 'translateX(-50%)' }}
      data-degraded={degraded ? 'true' : undefined}
      data-loading={isLoading ? 'true' : undefined}
      initial={popover.initial}
      animate={popover.animate}
      exit={popover.exit}
      role="dialog"
      aria-label={result.title ?? 'Plugin result'}
    >
      {result.title && <div className="plugin-popover-title">{result.title}</div>}
      <div className="plugin-popover-body">{renderContent(result.content)}</div>
      <div className="plugin-popover-actions">
        {entry.retry && (
          <button
            className="btn plugin-popover-retry"
            onClick={() => {
              if (entry.retry) {
                commandResults.dismiss(entry.id)
                void execute({
                  pluginId: entry.retry.pluginId,
                  commandId: entry.retry.commandId,
                  context: { ...(entry.retry.context as Record<string, unknown>), _skipCache: true } as never,
                  anchor: entry.retry.anchor,
                } as never)
              }
            }}
          >
            Retry
          </button>
        )}
        {dismissible && (
          <button className="btn plugin-popover-close" onClick={dismiss} aria-label="Close">Close</button>
        )}
      </div>
    </motion.div>
  )
}

function PluginDialog({ entry, execute: _execute }: { entry: ActiveResult; execute: (opts: never) => void }) {
  const result = entry.result as Extract<PluginCommandResult, { type: 'dialog' }>
  const enterT = useMotionTransition(ENTER_TRANSITION)
  const exitT = useMotionTransition(EXIT_TRANSITION)
  const dismiss = useCallback(() => commandResults.dismiss(entry.id), [entry.id])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); dismiss() }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [dismiss])
  return (
    <div className="plugin-dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) dismiss() }}>
      <motion.div
        className="plugin-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={result.title ?? 'Plugin dialog'}
        initial={{ opacity: 0, scale: 0.98, transition: enterT }}
        animate={{ opacity: 1, scale: 1, transition: enterT }}
        exit={{ opacity: 0, scale: 0.98, transition: exitT }}
      >
        {result.title && <div className="plugin-dialog-title">{result.title}</div>}
        <div className="plugin-dialog-body">{renderContent(result.content)}</div>
        <div className="plugin-dialog-actions">
          {(result.actions ?? []).map((a) => (
            <button
              key={a.id}
              className={`btn ${a.style === 'primary' ? 'btn-primary' : a.style === 'danger' ? 'btn-danger' : ''}`}
              onClick={dismiss}
            >
              {a.label}
            </button>
          ))}
          {(result.actions ?? []).length === 0 && <button className="btn" onClick={dismiss}>Close</button>}
        </div>
      </motion.div>
    </div>
  )
}

function renderContent(content: PluginResultContent | undefined) {
  if (!content) return null
  if (content.kind === 'text') return <div className="plugin-content-text">{content.text}</div>
  if (content.kind === 'markdown') return <Markdown text={content.markdown} />
  return (
    <dl className="plugin-content-kv">
      {content.items.map((it, i) => (
        <div key={i}><dt>{it.key}</dt><dd>{it.value}</dd></div>
      ))}
    </dl>
  )
}
