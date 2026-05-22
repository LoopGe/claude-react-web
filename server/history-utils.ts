/**
 * Push an item into a bounded array, evicting the oldest entry when the
 * cap is exceeded. This is the single implementation used by the session
 * pump, pushToSession, and appendRecap so any future buffer-strategy
 * change (e.g. ring buffer) only needs one edit.
 */
export function pushBounded<T>(arr: T[], item: T, cap: number): void {
  arr.push(item)
  if (arr.length > cap) {
    // In-place copy avoids the throwaway removed-elements array that
    // splice() allocates in its return value.
    const excess = arr.length - cap
    for (let i = excess; i < arr.length; i++) arr[i - excess] = arr[i]
    arr.length = cap
  }
}
