// Bespoke rendering for the `ReportFindings` tool_use.
//
// The agent calls ReportFindings with `{ level, findings: [{ file, line,
// summary, failure_scenario, category, verdict?, outcome? }] }` to surface a
// structured code-review report. This card renders that payload as a
// severity-ordered list (verdict chips + expandable failure scenarios) instead
// of the generic ToolCard / raw-JSON fallback. The tool itself is provided
// out-of-band (MCP / plugin / SDK custom tool); this component only owns the
// rendering, mirroring ExitPlanMode→PlanCard / Agent→SubagentCard.
//
// All parsing is defensive: the SDK's input shape drifts, so a malformed/
// missing findings array degrades to a placeholder rather than crashing.

import { memo, useMemo, type ReactNode } from 'react'
import { AnimatedDetails } from './AnimatedCollapse'
import { IconClipboardList } from './icons/ToolIcons'

type Verdict = 'CONFIRMED' | 'PLAUSIBLE'
type Outcome = 'fixed' | 'skipped' | 'no_change_needed'

interface ParsedFinding {
  file: string
  line: number | null
  summary: string
  failureScenario: string | null
  category: string | null
  verdict: Verdict | null
  outcome: Outcome | null
}

interface Props {
  input: Record<string, unknown> | undefined
}

function parseVerdict(v: unknown): Verdict | null {
  return v === 'CONFIRMED' ? 'CONFIRMED' : v === 'PLAUSIBLE' ? 'PLAUSIBLE' : null
}

function parseOutcome(o: unknown): Outcome | null {
  return o === 'fixed' || o === 'skipped' || o === 'no_change_needed' ? (o as Outcome) : null
}

function parseFindings(raw: unknown): ParsedFinding[] {
  if (!Array.isArray(raw)) return []
  const out: ParsedFinding[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const f = item as Record<string, unknown>
    const file = typeof f.file === 'string' ? f.file : ''
    const summary = typeof f.summary === 'string' ? f.summary : ''
    // A finding with neither file nor summary is too degraded to render.
    if (!file && !summary) continue
    out.push({
      file,
      summary,
      line: typeof f.line === 'number' && Number.isFinite(f.line) ? f.line : null,
      failureScenario: typeof f.failure_scenario === 'string' && f.failure_scenario ? f.failure_scenario : null,
      category: typeof f.category === 'string' && f.category ? f.category : null,
      verdict: parseVerdict(f.verdict),
      outcome: parseOutcome(f.outcome),
    })
  }
  return out
}

/** Verdict → CSS modifier class for chip + row severity colour. CONFIRMED is
 *  the most severe (a verified defect); PLAUSIBLE is uncertain; absent is
 *  neutral. */
function verdictClass(v: Verdict | null): string {
  if (v === 'CONFIRMED') return 'findings-verdict-confirmed'
  if (v === 'PLAUSIBLE') return 'findings-verdict-plausible'
  return 'findings-verdict-none'
}

/** Resolve a finding's row severity class + chip(s).
 *
 *  - Resolved outcomes (fixed / no_change_needed) CLOSE the finding: the row
 *    reflects the outcome and only the outcome chip shows — the original
 *    verdict no longer matters.
 *  - 'skipped' does NOT resolve the finding (the user chose not to address
 *    it), so the verdict severity stays on the row AND the verdict chip stays
 *    visible, with a 'skipped' marker appended — otherwise a skipped
 *    confirmed-bug is indistinguishable from a skipped plausible-hunch.
 *  - No outcome: row + chip carry the verdict. */
function resolveFinding(f: ParsedFinding): { rowClass: string; chips: ReactNode[] } {
  if (f.outcome === 'fixed') {
    return { rowClass: 'findings-outcome-fixed', chips: [<span key="o" className="tool-chip findings-chip findings-outcome-fixed">fixed</span>] }
  }
  if (f.outcome === 'no_change_needed') {
    return { rowClass: 'findings-verdict-none', chips: [<span key="o" className="tool-chip findings-chip findings-outcome-none">no change needed</span>] }
  }
  const vChip = (
    <span key="v" className={`tool-chip findings-chip ${verdictClass(f.verdict)}`}>
      {(f.verdict ?? 'finding').toLowerCase()}
    </span>
  )
  if (f.outcome === 'skipped') {
    return {
      rowClass: verdictClass(f.verdict),
      chips: [vChip, <span key="s" className="tool-chip findings-chip findings-outcome-skipped">skipped</span>],
    }
  }
  return { rowClass: verdictClass(f.verdict), chips: [vChip] }
}

export const FindingsCard = memo(function FindingsCard({ input }: Props) {
  const levelRaw = typeof input?.level === 'string' ? input.level : ''
  // Fall back to the raw string so an unknown level (e.g. 'critical') still
  // surfaces instead of vanishing; only special-case the display label.
  const levelLabel = levelRaw ? (levelRaw === 'xhigh' ? 'x-high' : levelRaw) : ''
  const findings = useMemo(() => parseFindings(input?.findings), [input?.findings])

  return (
    <div className="findings-card">
      <div className="findings-card-header">
        <IconClipboardList size={14} />
        <span className="findings-card-title">Code review findings</span>
        {levelLabel && <span className="findings-level-badge">{levelLabel}</span>}
        <span className="findings-count">{findings.length} finding{findings.length === 1 ? '' : 's'}</span>
      </div>

      {findings.length === 0 ? (
        <div className="findings-empty">No structured findings in this report.</div>
      ) : (
        <ol className="findings-list">
          {findings.map((f, i) => {
            const { rowClass, chips } = resolveFinding(f)
            const loc = f.file ? (f.line != null ? `${f.file}:${f.line}` : f.file) : ''
            return (
              <li key={i} className={`finding-row ${rowClass}`}>
                <div className="finding-row-head">
                  {chips}
                  {f.category && <span className="finding-category">{f.category}</span>}
                  {loc && <span className="finding-loc">{loc}</span>}
                </div>
                {f.summary && <div className="finding-summary">{f.summary}</div>}
                {f.failureScenario && (
                  <AnimatedDetails
                    className="finding-scenario-details"
                    summary={<span className="finding-scenario-label">failure scenario</span>}
                  >
                    <div className="finding-scenario-body">{f.failureScenario}</div>
                  </AnimatedDetails>
                )}
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
})
