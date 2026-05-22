/** One question within an AskUserQuestion tool_use. Mirrors the SDK's
 *  internal shape but narrowed so the frontend can rely on it.
 *  Canonical definition — server and client both re-export from here. */
export interface QuestionSpec {
  question: string
  /** Short header/label for the question, shown as a chip in the UI. */
  header?: string
  multiSelect?: boolean
  options: Array<{
    label: string
    description?: string
    /** Preview body (markdown by default). */
    preview?: string
  }>
}
