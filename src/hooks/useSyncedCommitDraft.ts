import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent, KeyboardEvent } from 'react'

interface Options {
  /** Canonical value from the caller. Changes replace the draft only while
   *  the input is not focused, so a server refresh cannot overwrite typing. */
  source: string
  /** Owns normalization, persistence and error recovery. The hook passes the
   *  raw draft through unchanged. */
  onCommit: (draft: string) => void | Promise<void>
}

/** Shared draft skeleton for inputs that commit on Enter/blur and cancel the
 *  blur caused by Escape. Callers keep their own parsing and commit policy. */
export function useSyncedCommitDraft({ source, onCommit }: Options) {
  const [draft, setDraft] = useState(source)
  const inputRef = useRef<HTMLInputElement>(null)
  // Escape calls blur() synchronously, before a queued draft reset could
  // render. The ref is the safe channel that tells that blur not to commit.
  const skipCommitRef = useRef(false)

  useEffect(() => {
    if (inputRef.current && document.activeElement === inputRef.current) return
    setDraft(source)
  }, [source])

  const onBlur = () => {
    if (skipCommitRef.current) {
      skipCommitRef.current = false
      setDraft(source)
      return
    }
    void onCommit(draft)
  }

  return {
    draft,
    inputRef,
    reset: () => setDraft(source),
    inputProps: {
      ref: inputRef,
      value: draft,
      onChange: (event: ChangeEvent<HTMLInputElement>) => setDraft(event.target.value),
      onBlur,
      onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          inputRef.current?.blur()
        } else if (event.key === 'Escape') {
          skipCommitRef.current = true
          inputRef.current?.blur()
        }
      },
    },
  }
}
