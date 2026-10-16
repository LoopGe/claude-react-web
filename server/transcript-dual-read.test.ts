// Task 6 — MIGRATION GUARD: dual-read parity gate.
//
// Proves the new seq-window transcript path produces output IDENTICAL to the
// legacy `/history` disk path on the same raw transcript JSONL:
//
//   Path A (legacy):  history-reader.paginateJsonl(raw, sid, { limit: 200 })
//                     — parseRenderable (isRenderableSdkMessage gate on the
//                     RAW line) → normalize(o, sid, trim=true).
//
//   Path B (seq):     the exact record pipeline SessionManager's reconcile
//                     uses for disk rows (composeTranscriptEntries →
//                     backfillFromEntries): historyEntriesFromJsonl (the same
//                     parseRenderable gate + normalize, untrimmed) →
//                     trimLargeToolResults → TranscriptStore.record via
//                     backfillFromEntries → window(undefined, 200).
//
// Both paths emit the same normalize() output, so per-message deep-equality
// IS the acceptance gate ("the two paths are equivalent") and must not be
// weakened to per-field diffs. The ONE intentional structural difference —
// the seq — lives on the SeqMessage WRAPPER (window().messages[].seq), not
// inside msg, so mapping `.msg` off the window is the precise exclusion; a
// dedicated assertion below pins that msg itself carries no seq field.
//
// A second focused test pins the uuid space the retraction path receives
// (model_refusal_fallback.retracted_message_uuids → pump onTranscriptEvict →
// evictTranscript → store.evict/seqOf), which Task 5 flagged: live-recorded
// top-level user prompts are indexed under the SERVER-minted uuid, while the
// CLI-side retraction list can only reference SDK-minted uuids.

import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { historyEntriesFromJsonl, paginateJsonl } from './history-reader'
import { TranscriptStore } from './transcript-store'
import {
  TranscriptSidecar,
  backfillFromEntries,
  recordTranscriptMessage,
  type TranscriptHolder,
} from './transcript-sidecar'
import { trimLargeToolResults } from './history-utils'
import { rewriteSeedPromptUuids, type PromptUuidEntry } from './prompt-uuid-store'

/** A real transcript's first ~300 lines. Local-machine fixture: the test
 *  skips when absent so CI and fresh clones never depend on it. The inline
 *  fixture below carries the deterministic coverage. */
const REAL_TRANSCRIPT =
  '/Users/loop/.claude/projects/-Users-loop-Codes-claude-react-web/89b7ae30-ba3b-4c0f-898a-b4e8c5831f10.jsonl'

const SID = 'dual-read-sid'

/** Comparison keys per message (the migration acceptance gate). */
const PARITY_KEYS = ['type', 'subtype', 'uuid', 'parent_tool_use_id', 'message'] as const

function parityKey(m: unknown): Record<string, unknown> {
  const r = m as Record<string, unknown>
  return Object.fromEntries(PARITY_KEYS.map((k) => [k, r[k] ?? null]))
}

/** Path B: feed raw JSONL through the reconcile record pipeline and return
 *  the store's newest page (seq wrapper stripped). Mirrors
 *  SessionManager.composeTranscriptEntries + backfillFromEntries for a
 *  fixture with no result frames / no prompt-uuid bridge (both merge steps
 *  are identity when their stores are empty, as on a fresh fixture). */
function seqWindowMessages(raw: string): { messages: unknown[]; store: TranscriptStore } {
  const store = new TranscriptStore(SID)
  const holder: TranscriptHolder = {
    store,
    // dir=undefined → the sidecar no-its-nothing mode (appendRow is a no-op),
    // so the pipeline is exercised without touching the filesystem.
    sidecar: new TranscriptSidecar(undefined, SID),
    reconciled: true,
  }
  // readHistoryEntries normalizes untrimmed (search recall); the reconcile
  // then applies the live-path cap. Same two steps here.
  const entries = historyEntriesFromJsonl(raw, SID).map((e) => e.message)
  for (const m of entries) trimLargeToolResults(m as Parameters<typeof trimLargeToolResults>[0])
  backfillFromEntries(holder, entries)
  return { messages: store.window(undefined, 200).messages.map((m) => m.msg), store }
}

describe('transcript dual-read parity (Task 6 migration guard)', () => {
  describe('real transcript fixture (skipped when the local file is absent)', () => {
    const itReal = it.runIf(existsSync(REAL_TRANSCRIPT))

    itReal('newest 200-message page: seq window output equals the legacy history page', () => {
      const raw = readFileSync(REAL_TRANSCRIPT, 'utf8').split('\n').slice(0, 300).join('\n')
      const a = paginateJsonl(raw, SID, { limit: 200 }).messages
      const { messages: b } = seqWindowMessages(raw)

      expect(b.length).toBe(a.length)
      expect(a.length).toBe(200) // the fixture is deep enough to fill the page
      for (let i = 0; i < a.length; i++) {
        // The acceptance gate, per the brief's key list…
        expect(parityKey(b[i]), `parity key mismatch at index ${i}`).toEqual(parityKey(a[i]))
        // …and the stronger form: both sides are the same normalize() of the
        // same line, so the FULL objects must be equal (any drift here is an
        // implementation bug to fix, not an assertion to weaken).
        expect(b[i], `full-object mismatch at index ${i}`).toEqual(a[i])
      }
    })

    itReal('older page: beforeUuid pagination equals a before-seq window', () => {
      const raw = readFileSync(REAL_TRANSCRIPT, 'utf8').split('\n').slice(0, 300).join('\n')
      const anchorUuid = (paginateJsonl(raw, SID, { limit: 200 }).messages[100] as { uuid?: string })?.uuid
      expect(anchorUuid).toBeTruthy()

      const a = paginateJsonl(raw, SID, { limit: 50, beforeUuid: anchorUuid }).messages
      // beforeUuid ends the legacy page just before the anchor's renderable
      // index; the seq window's `before` is an exclusive seq bound — with the
      // store holding exactly the renderable set in file order, the two pick
      // the same 50 messages.
      const { store } = seqWindowMessages(raw)
      const anchorSeq = store.seqOf(anchorUuid!) // truthiness asserted above
      expect(anchorSeq).toBeDefined()
      const page = store.window(anchorSeq, 50).messages.map((m) => m.msg)

      expect(page.length).toBe(a.length)
      for (let i = 0; i < a.length; i++) {
        expect(parityKey(page[i])).toEqual(parityKey(a[i]))
        expect(page[i]).toEqual(a[i])
      }
    })
  })

  describe('deterministic inline fixture', () => {
    // Raw JSONL lines exactly as the CLI persists them. Covers every gate
    // branch of isRenderableSdkMessage: kept (user prompt, assistant text,
    // tool_use/tool_result pair, broadcast system subtype) and dropped
    // (isSidechain, isMeta, interrupt placeholder).
    const lines: string[] = [
      JSON.stringify({
        type: 'user', uuid: 'u1', session_id: SID,
        timestamp: '2026-01-01T00:00:00.000Z',
        parentUuid: null,
        message: { role: 'user', content: 'list files then summarize' },
      }),
      JSON.stringify({
        type: 'assistant', uuid: 'a1', session_id: SID,
        timestamp: '2026-01-01T00:00:01.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Running ls first.' }] },
      }),
      JSON.stringify({
        type: 'assistant', uuid: 'a2', session_id: SID,
        timestamp: '2026-01-01T00:00:02.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls' } }],
        },
      }),
      JSON.stringify({
        type: 'user', uuid: 'u2', session_id: SID,
        timestamp: '2026-01-01T00:00:03.000Z',
        parentUuid: 'a2',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'file-a\nfile-b' }],
        },
      }),
      JSON.stringify({
        type: 'system', subtype: 'api_retry', uuid: 's1', session_id: SID,
        timestamp: '2026-01-01T00:00:04.000Z',
        retryAttempt: 1, maxRetries: 3,
      }),
      // ---- dropped below ----
      JSON.stringify({
        type: 'assistant', uuid: 'sc1', session_id: SID, isSidechain: true,
        timestamp: '2026-01-01T00:00:05.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'subagent inner stream' }] },
      }),
      JSON.stringify({
        type: 'user', uuid: 'm1', session_id: SID, isMeta: true,
        timestamp: '2026-01-01T00:00:06.000Z',
        message: { role: 'user', content: 'meta line' },
      }),
      JSON.stringify({
        type: 'user', uuid: 'i1', session_id: SID,
        timestamp: '2026-01-01T00:00:07.000Z',
        message: { role: 'user', content: '[Request interrupted by user]' },
      }),
    ]
    const raw = lines.join('\n')

    it('seq window output equals the legacy history page, message for message', () => {
      const a = paginateJsonl(raw, SID, { limit: 200 }).messages
      const { messages: b, store } = seqWindowMessages(raw)

      // Kept: prompt, text, tool_use, tool_result, api_retry. Dropped:
      // sidechain, meta, interrupt placeholder (identically on both paths —
      // the renderability gate is the shared isRenderableSdkMessage).
      expect(a.length).toBe(5)
      expect(b.length).toBe(a.length)
      expect(a.map((m) => (m as { uuid?: string }).uuid)).toEqual(['u1', 'a1', 'a2', 'u2', 's1'])
      for (let i = 0; i < a.length; i++) {
        expect(parityKey(b[i]), `parity key mismatch at index ${i}`).toEqual(parityKey(a[i]))
        expect(b[i], `full-object mismatch at index ${i}`).toEqual(a[i])
      }
      // The store assigned exactly the kept set, in file order.
      expect(store.visibleCount).toBe(5)
      expect(store.window(undefined, 200).messages.map((m) => m.seq)).toEqual([0, 1, 2, 3, 4])
    })

    it('the seq lives on the window wrapper only — msg carries no seq field', () => {
      // The one intentional structural difference between the paths: the seq
      // is NOT a field of the message. `map(m => m.msg)` is therefore the
      // precise "strip seq" step — nothing inside the message needs removing.
      const { store } = seqWindowMessages(raw)
      for (const entry of store.window(undefined, 200).messages) {
        expect(Object.keys(entry)).toEqual(['seq', 'uuid', 'msg'])
        expect((entry.msg as Record<string, unknown> | null)?.['seq']).toBeUndefined()
      }
    })

    it('tool_result-bearing user frames keep their parent_tool_use_id on both paths', () => {
      const a = paginateJsonl(raw, SID, { limit: 200 }).messages
      const { messages: b } = seqWindowMessages(raw)
      // Disk lines don't carry parent_tool_use_id; normalize synthesizes it
      // from the tool_result block (parity with the live wire shape).
      expect((a[3] as { parent_tool_use_id?: string }).parent_tool_use_id).toBe('tool-1')
      expect((b[3] as { parent_tool_use_id?: string }).parent_tool_use_id).toBe('tool-1')
    })
  })

  describe('retraction uuid space (Task 5 follow-up, pinned current behavior)', () => {
    // Trace under test: the pump sees `model_refusal_fallback` and hands
    // `retracted_message_uuids` to deps.onTranscriptEvict (session-pump.ts,
    // narrowed to string uuids) → SessionManager.evictTranscriptAndBroadcast
    // → evictTranscript → ensureTranscriptReconciled → store.evict(uuids)
    // (uuid → seq via store.seqOf). The question Task 5 left open: WHICH
    // uuid space does that list use, relative to the store's index?
    //
    // Codebase-established identity: the store indexes LIVE-recorded
    // top-level user prompts under the SERVER-minted uuid `u` (send() mints
    // it; the pump drops the SDK echo, so pushToSession's copy is the only
    // registration), while the CLI re-mints uuids on ingest — the documented
    // premise of the entire prompt-uuid bridge (prompt-uuid-store.ts header;
    // onPromptEcho FIFO-pairs the echo's `v` with the still-unpaired `u`;
    // rewriteSeedPromptUuids is an exact v→u lookup). A CLI-generated
    // retracted_message_uuids list therefore references the SDK/`v` space.
    // The reconcile path rewrites v→u (composeTranscriptEntries), so the
    // store indexes prompts under `u` on BOTH the live and rebuilt paths.
    //
    // NOT establishable without a live CLI refusal event: whether a real
    // retracted_message_uuids list ever references a USER prompt at all
    // (vs only the refused assistant leg). Pinned below: the CURRENT
    // behavior of seqOf/evict against both spaces — a v-space retraction of
    // a u-indexed user prompt misses the index and tombstones nothing.
    // NEEDS LIVE CONFIRMATION (see task-6-report.md) before relying on
    // retraction of inherited/restarted user prompts.

    it('live prompts index under the server-minted u; v-space uuids miss the index; assistant legs resolve', () => {
      const store = new TranscriptStore(SID)
      const holder: TranscriptHolder = {
        store,
        sidecar: new TranscriptSidecar(undefined, SID),
        reconciled: true,
      }
      const u = 'server-minted-u1'
      // Live ingest path: send() mints u, the pump drops the echo, and
      // pushToSession records the ring copy — under u.
      recordTranscriptMessage(holder, {
        type: 'user', uuid: u, parent_tool_use_id: null, session_id: SID,
        message: { role: 'user', content: 'refuse me' },
      })
      // Assistant frames arrive from the SDK stream carrying the CLI's own
      // uuid — the same space a CLI-side retraction list uses.
      recordTranscriptMessage(holder, {
        type: 'assistant', uuid: 'sdk-a1', parent_tool_use_id: null, session_id: SID,
        message: { role: 'assistant', content: [{ type: 'text', text: 'refused leg' }] },
      })

      expect(store.seqOf(u)).toBe(0)
      expect(store.seqOf('sdk-a1')).toBe(1)

      // The bridge maps v→u (its whole reason to exist): the same prompt on
      // disk carries the SDK uuid v, and rewriteSeedPromptUuids rewrites it
      // to u before the reconcile records it — proving v ≠ u by design.
      const v = 'sdk-uuid-v1'
      const bridge: PromptUuidEntry[] = [{ u, v }]
      const diskCopy = [{
        type: 'user', uuid: v, parent_tool_use_id: null, session_id: SID,
        message: { role: 'user', content: 'refuse me' },
      }] as unknown as Parameters<typeof rewriteSeedPromptUuids>[0]
      expect((rewriteSeedPromptUuids(diskCopy, bridge)[0] as { uuid: string }).uuid).toBe(u)

      // CURRENT BEHAVIOR PIN: evictTranscript hands the raw retraction list
      // straight to store.evict (no prompt-uuid rewrite on the evict path),
      // so a v-space retraction of a u-indexed user prompt resolves nothing.
      expect(store.seqOf(v)).toBeUndefined()
      expect(store.evict([v])).toEqual([])
      // …while a retraction referencing the assistant leg (necessarily
      // CLI-space) resolves and tombstones.
      expect(store.evict(['sdk-a1'])).toEqual([1])
      // Idempotent + leaves the user prompt intact.
      expect(store.evict(['sdk-a1', v])).toEqual([])
      expect(store.window(undefined, 10).messages.map((m) => m.seq)).toEqual([0])
    })
  })
})
