// Skill preview data access: the SKILL.md fetch plus one-at-a-time preview
// state shared by every preview entry point (global Settings → Skills rows,
// session Settings → Loaded skills rows).

import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { api } from './useApi'
import { basenameOf, parentOf } from '../utils/paths'
import type { SkillRecord } from '../../shared/skills'

/** Fetch one skill's SKILL.md (returned as `skill.content`). Project-scope
 *  reads are cwd-qualified so the right workspace's copy is served; user
 *  scope needs no query. The URL addresses the skill by its DIRECTORY name
 *  (what the server resolves) — a record whose frontmatter name drifted
 *  from the directory is still fetched from the directory it lives in, and
 *  the response then carries the mismatch error the modal shows. */
export async function fetchSkillContent(
  record: SkillRecord,
  cwd?: string,
): Promise<SkillRecord> {
  const query = record.scope === 'project' && cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''
  // path is always <root>/<dir>/SKILL.md — the parent's basename is the dir.
  const dirName = basenameOf(parentOf(record.path))
  const res = await api.get<{ skill: SkillRecord }>(
    `/skills/${record.scope}/${encodeURIComponent(dirName)}${query}`,
  )
  return res.skill
}

/** One-at-a-time skill preview state, last-click-wins: a superseded fetch
 *  never writes `preview` and never throws (its result — or failure — is
 *  irrelevant to whatever the user clicked since). `close` also supersedes
 *  any in-flight open so a late response cannot pop the modal back up. */
export function useSkillPreview(cwd?: string) {
  const [preview, setPreview] = useState<SkillRecord | null>(null)
  const reqRef = useRef(0)

  // A cwd change supersedes in-flight opens AND drops an already-open
  // preview — its record describes another workspace's file. Layout effect
  // so the invalidation lands at commit time: a passive effect would leave
  // a microtask window where a stale response still passes the guard below.
  /* eslint-disable react-hooks/set-state-in-effect -- the preview must be
     dropped with the cwd commit, not one paint later */
  useLayoutEffect(() => {
    reqRef.current += 1
    setPreview(null)
  }, [cwd])
  /* eslint-enable react-hooks/set-state-in-effect */

  const open = useCallback(
    async (record: SkillRecord): Promise<void> => {
      const id = ++reqRef.current
      try {
        const skill = await fetchSkillContent(record, cwd)
        if (id === reqRef.current) setPreview(skill)
      } catch (e) {
        if (id === reqRef.current) {
          // Keep the original error (transport ApiError carries status/hint);
          // only invent a message when there is none, so every entry point
          // surfaces the same wording (display placement stays per caller).
          throw (e as Error).message ? e : new Error(`Couldn't load ${record.name}`)
        }
      }
    },
    [cwd],
  )

  const close = useCallback(() => {
    reqRef.current += 1
    setPreview(null)
  }, [])

  return { preview, open, close }
}
