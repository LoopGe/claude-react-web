/// <reference lib="dom" />
/// <reference types="vite/client" />

import { createRoot } from 'react-dom/client'
import { QuestionDialog } from '../../../src/components/QuestionDialog'
import { QuestionCard } from '../../../src/components/tool-views/QuestionCard'
import { QuestionAnswersProvider } from '../../../src/hooks/useQuestionAnswers'
import { ReopenQuestionProvider } from '../../../src/hooks/useReopenQuestion'
import type { ReopenQuestionValue } from '../../../src/hooks/useReopenQuestion'
import type { PermissionRequest, QuestionSpec } from '../../../src/types'
import type { QuestionAnswerEntry } from '../../../src/utils/question-answers'
import '../../../src/styles/index.css'

const params = new URLSearchParams(window.location.search)
const prompt = 'Which approach should I use?'
const questions: QuestionSpec[] = [{
  header: 'Approach',
  question: prompt,
  options: [
    { label: 'Unified', description: 'Match the plan card and keep the transcript quiet.' },
    { label: 'Legacy', description: 'Keep the previous nested-card treatment.' },
  ],
}, {
  header: 'Validation',
  question: 'Which checks should run before this is ready?',
  multiSelect: true,
  options: [
    { label: 'Unit tests', description: 'Exercise the component state transitions.' },
    { label: 'Browser tests', description: 'Measure the real Chromium layout.' },
  ],
}]

const request: Extract<PermissionRequest, { kind: 'question' }> = {
  kind: 'question',
  id: 'question-layout-request',
  toolName: 'AskUserQuestion',
  questions,
  toolUseID: 'question-pending',
  createdAt: 0,
}

const reopen: ReopenQuestionValue = {
  minimizedToolUseIds: params.has('minimized') ? new Set(['question-pending']) : new Set(),
  minimizedPlanToolUseIds: new Set(),
  minimizedPermissionToolUseIds: new Set(),
  onReopen: () => {},
  onReopenPlan: () => {},
  onReopenPermission: () => {},
}

const answers = new Map<string, QuestionAnswerEntry[]>([
  ['question-pending', []],
  ['question-answered', [
    { question: prompt, answer: 'Unified' },
    { question: questions[1].question, answer: ['Unit tests', 'Browser tests'] },
  ]],
  ['question-skipped', [
    { question: prompt, answer: null },
    { question: questions[1].question, answer: null },
  ]],
  ['question-clarified', [
    { question: prompt, answer: 'Please explain the trade-off first.', clarified: true },
    { question: questions[1].question, answer: null },
  ]],
])

createRoot(document.getElementById('root')!).render(
  params.has('inline') ? (
    <QuestionAnswersProvider value={answers}>
      <ReopenQuestionProvider value={reopen}>
        <main style={{ maxWidth: 760, margin: '0 auto', padding: 16, background: 'var(--bg)' }}>
          <div data-neutral-probe style={{ background: 'var(--bg-elev)', height: 1 }} />
          {Array.from(answers.keys()).map(id => (
            <div key={id} data-question-fixture={id}>
              <QuestionCard input={{ questions }} toolUseId={id} />
            </div>
          ))}
        </main>
      </ReopenQuestionProvider>
    </QuestionAnswersProvider>
  ) : (
    <div className="chat-panel" style={{ position: 'relative', width: '100vw', height: '100vh', background: 'var(--bg)' }}>
      <QuestionDialog
        request={request}
        onSubmit={() => {}}
        onClarify={() => {}}
        onSkipAll={() => {}}
        onMinimize={() => {}}
      />
    </div>
  ),
)
