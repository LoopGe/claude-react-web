// Change signal for the lazily loaded markdown features: the on-demand
// highlight.js grammars (lowlight-instance.ts).
//
// The contract every renderer relies on:
//   * a render made while a grammar it needed was still loading is never
//     cached (compileMarkdown and highlightLineHast keep it out of their
//     caches), so nothing can serve a pre-load render after the load;
//   * every finished load bumps ONE version counter, and the components that
//     render through those caches subscribe to it (useMarkdownFeaturesVersion
//     in <Markdown>, useHighlightLanguageReady in <DiffLine>), so the affected
//     blocks re-render, and recompile, the moment the load lands.
// markdown-prefetch.ts starts the same loads earlier (incoming frames, replay,
// hydrated history) so that in the common case the first paint is already
// final; correctness never depends on it.
//
// KaTeX is deliberately NOT lazy: a formula rendered as source text first and
// as KaTeX later changes the row's height, which re-pins / shifts the
// virtualised transcript (see AGENTS.md).

import { useSyncExternalStore } from 'react'

let version = 0
const listeners = new Set<() => void>()

/** Bump the feature version and wake every subscribed renderer. Called once
 *  per finished load (one grammar together with its deps). */
export function notifyMarkdownFeaturesChanged(): void {
  version++
  for (const listener of [...listeners]) listener()
}

export function subscribeMarkdownFeatures(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getMarkdownFeaturesVersion(): number {
  return version
}

/** Re-render the calling component whenever a lazy markdown feature finishes
 *  loading. The value itself is only a change signal. */
export function useMarkdownFeaturesVersion(): number {
  return useSyncExternalStore(subscribeMarkdownFeatures, getMarkdownFeaturesVersion, getMarkdownFeaturesVersion)
}
