// Link context for rendered Markdown: where a relative file link resolves from
// and who can open it. Provided by the transcript (session cwd) and by the
// resource modal's file body (the previewed file's directory); absent in
// standalone renders, where Markdown links keep their plain browser behavior.

import { createContext, createElement, useContext, useMemo, type ReactNode } from 'react'
import { useOptionalOpenResource } from './context'
import type { OpenOptions } from './tab-store'

export interface ResourceLinkContextValue {
  sessionId: string
  /** Directory relative paths resolve against. */
  baseDir: string
  /** Absolute path of the file being previewed (for bare `#L10` anchors). */
  baseFile?: string
  openResource: (sessionId: string, address: string, options?: OpenOptions) => void
}

const ResourceLinkContext = createContext<ResourceLinkContextValue | null>(null)

export function ResourceLinkProvider({
  sessionId,
  baseDir,
  baseFile,
  children,
}: {
  sessionId?: string | null
  baseDir?: string | null
  baseFile?: string
  children: ReactNode
}) {
  // Optional opener: hosts rendered outside the App resource provider (tests,
  // standalone markdown) fall back to plain links instead of throwing.
  const openResource = useOptionalOpenResource()
  const value = useMemo<ResourceLinkContextValue | null>(
    () =>
      openResource && sessionId && baseDir
        ? { sessionId, baseDir, baseFile, openResource }
        : null,
    [openResource, sessionId, baseDir, baseFile],
  )
  return createElement(ResourceLinkContext.Provider, { value }, children)
}

export function useResourceLinkContext(): ResourceLinkContextValue | null {
  return useContext(ResourceLinkContext)
}