/** Shared group-name rules. App's `validateGroupName` owns the FULL check
 *  (this + the live duplicate scan, which needs the group list); the New
 *  Session dialog's inline "Create group …" offer pre-checks the PURE rules
 *  so it never offers a row that submit would deterministically reject. */

/** Sidebar pill layout breaks past this length. */
export const MAX_GROUP_NAME_LENGTH = 40

/** Pure group-name checks (empty / over-length). Returns a user-facing
 *  error string, or null when the name passes. */
export function groupNameIssue(raw: string): string | null {
  const name = raw.trim()
  if (!name) return 'Group name cannot be empty.'
  if (name.length > MAX_GROUP_NAME_LENGTH) {
    return `Group name is too long (max ${MAX_GROUP_NAME_LENGTH} chars).`
  }
  return null
}
