// Immutable-value helpers for the neutral vocabulary (mirrors DSH
// packages/util/values deepFreeze). Pure object mechanics with zero imports,
// so it stays inside the vocabulary's neutrality boundary.

/** Deep-freeze an object graph IN PLACE while leaving live AbortSignal
 *  objects mutable. Iterative worklist + WeakSet cycle guard: every reachable
 *  enumerable child is frozen exactly once, cycles terminate, and a live
 *  signal riding inside a frozen holder keeps working (abort(), listeners).
 *  Property reads ride the worklist as deferred tasks, so each enumerable
 *  child is read once, in visit order. Returns the SAME value — freezing is
 *  in place, not a copy (callers detach first when they need a snapshot). */
export function deepFreeze<T>(value: T): T {
  const seen = new WeakSet<object>()
  const pending: (
    | { kind: 'visit'; node: unknown }
    | { kind: 'property'; source: Record<string, unknown>; key: string }
  )[] = [{ kind: 'visit', node: value }]
  while (pending.length > 0) {
    const task = pending.pop()
    // pop() is typed T | undefined; the loop condition guarantees a task.
    if (task === undefined) continue
    if (task.kind === 'property') {
      pending.push({ kind: 'visit', node: task.source[task.key] })
      continue
    }
    const node = task.node
    if (node === null || typeof node !== 'object') continue
    if (node instanceof AbortSignal) continue
    if (seen.has(node)) continue
    seen.add(node)
    Object.freeze(node)
    const keys = Object.keys(node)
    for (let index = keys.length - 1; index >= 0; index--) {
      pending.push({ kind: 'property', source: node as Record<string, unknown>, key: keys[index] })
    }
  }
  return value
}