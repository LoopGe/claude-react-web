import { useEffect, useState } from 'react'

export interface Rotor {
  /** Currently-shown slot — always clamped into [0, count), 0 when the item
   *  set is empty, so no consumer can index past the end. */
  index: number
  /** Start / stop the rotation from the header's pointer handlers — the
   *  rotation suspends while the pointer rests on the header so the expand
   *  target stays put under the cursor. */
  hoverStart: () => void
  hoverEnd: () => void
}

interface RotorOpts {
  /** Signature of the item set — the join of the items' stable keys. The
   *  interval keys on this PRIMITIVE, never on the item array: callers derive
   *  fresh arrays every render, and an identity dep would restart the
   *  interval before it ever fired. A key add/remove/status flip changes the
   *  sig (and restarts from the first slot); a label text edit does not (and
   *  needs no restart — the label renders live). */
  sig: string
  /** Number of rotatable items (a primitive — safe as a dep). */
  count: number
  /** Whether the rotator should run at all (the card is collapsed / docked
   *  and there is something to rotate). */
  active: boolean
  /** Cadence in ms. */
  rotateMs?: number
}

/** Rotator for the collapsed-header task label shared by the TodoChecklist
 *  and MonitorBar docked bars: one item at a time, advancing every
 *  `rotateMs`, wrapping, restarting from the first slot whenever the item set
 *  or the active state changes, suspended while the pointer rests on the
 *  header.
 *
 *  The reset works by GENERATION, not by a reset effect: the stored slot
 *  carries the generation it was written under (`gen` = sig + active), and a
 *  stale generation simply DERIVES as slot 0 — no setState inside an effect
 *  (a cascading extra commit, which `react-hooks/set-state-in-effect`
 *  forbids) and no render-time state adjustment. The first tick of the fresh
 *  interval advances from slot 0 under the new generation. */
export function useRotor({ sig, count, active, rotateMs = 3000 }: RotorOpts): Rotor {
  const [paused, setPaused] = useState(false)
  const gen = `${sig}\u0000${active}`
  const [slot, setSlot] = useState({ gen, i: 0 })
  const index = slot.gen === gen && count > 0 ? Math.min(slot.i, count - 1) : 0

  useEffect(() => {
    if (!active || paused || count <= 1) return
    const t = window.setInterval(() => {
      setSlot((prev) => {
        // A reset meanwhile (generation moved on between renders): this tick
        // starts the fresh cycle — advance from slot 0 rather than carrying
        // the stale slot across.
        if (prev.gen !== gen) return { gen, i: 1 % count }
        return { gen, i: (prev.i + 1) % count }
      })
    }, rotateMs)
    return () => window.clearInterval(t)
  }, [active, paused, count, rotateMs, gen])

  return {
    index,
    hoverStart: () => setPaused(true),
    hoverEnd: () => setPaused(false),
  }
}
