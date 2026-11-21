// The ONE shared chunk-to-message assembler for the native provider core:
// the live turn loop and log replay both fold StreamChunks through this class,
// so their settlement (max-tokens tool-call drop, open-block fallback, replay
// prune) cannot diverge. Imports ONLY sibling vocabulary modules — zero SDK
// or host-domain imports. Mirrors DSH dsh-llm's assembler semantics: first
// close wins, straggler deltas/re-closes on a closed index are ignored, and
// delta-only protocols (no block-start/end) are tolerated.

import { brandString, type ToolCallId } from './brand.js'
import type { ContentBlock, ContentBlockType, FinishReason, TokenUsage } from './types.js'
import type { ModelMessageSource, ReplayEnvelope } from './source.js'
import { createAssistantMessage, type AssistantMessage } from './message.js'
import type { StreamChunk } from './stream.js'

/** Mark an unreachable closed-union branch: an unhandled typed variant fails
 *  at the call site, and a runtime value that escaped its type always throws. */
function assertNever(value: never, context: string): never {
  const rendered = (JSON.stringify(value) as string | undefined) ?? String(value)
  throw new Error(`unreachable variant in ${context}: ${rendered}`)
}

interface PartialBlock {
  blockType: ContentBlockType
  text: string
  toolCallId?: ToolCallId
  toolCallName?: string
  toolCallArguments: string
  /** Set by `block-end` — authoritative, and freezes the partial. */
  block?: ContentBlock
}

/**
 * Incrementally assembles raw {@link StreamChunk}s into complete
 * {@link ContentBlock}s and a final assistant message.
 *
 * The live loop feeds it while logging raw chunks for replay fidelity, then
 * reads `blocks()` / `message()` / `usage` / `finish` once the stream ends,
 * or `interruptedBlocks()` when cancellation cut the stream short. Reads are
 * non-destructive: every accessor re-runs settlement over the current push
 * state, so a mid-stream read never freezes a partial or drops later deltas.
 */
export class BlockAssembler {
  private partials = new Map<number, PartialBlock>()
  private order: number[] = []
  private _usage: TokenUsage | undefined
  private _finish: FinishReason | undefined
  private _replayState: ReplayEnvelope | undefined
  private _blocks: ContentBlock[] = []
  private _replay: ReplayEnvelope | undefined

  /** Feed one chunk into the assembly state, in stream order. */
  push(chunk: StreamChunk): void {
    switch (chunk.type) {
      case 'block-start': {
        if (!this.partials.has(chunk.index)) {
          this.order.push(chunk.index)
          this.partials.set(chunk.index, {
            blockType: chunk.blockType,
            text: '',
            toolCallArguments: '',
          })
        }
        return
      }
      case 'text-delta':
      case 'reasoning-delta': {
        const partial = this.ensure(chunk.index, chunk.type === 'text-delta' ? 'text' : 'reasoning')
        if (partial.block) return // closed by block-end; ignore stragglers
        partial.text += chunk.text
        return
      }
      case 'tool-call-delta': {
        const partial = this.ensure(chunk.index, 'tool-call')
        if (partial.block) return // closed by block-end; ignore stragglers
        partial.toolCallId = chunk.id
        if (chunk.name) partial.toolCallName = chunk.name
        partial.toolCallArguments += chunk.argumentsDelta
        return
      }
      case 'block-end': {
        const partial = this.ensure(chunk.index, chunk.block.type)
        // First close wins; ignoring re-close stragglers keeps streamed output
        // and the final assembled block in agreement.
        if (partial.block) return
        partial.block = chunk.block
        return
      }
      case 'usage': {
        this._usage = chunk.usage
        return
      }
      case 'finish': {
        this._finish = chunk.reason
        this._replayState = chunk.replayState
        return
      }
      default: return assertNever(chunk, 'BlockAssembler.push')
    }
  }

  /** Register a partial for a delta-only protocol (no block-start seen). */
  private ensure(index: number, blockType: ContentBlockType): PartialBlock {
    let partial = this.partials.get(index)
    if (!partial) {
      partial = { blockType, text: '', toolCallArguments: '' }
      this.partials.set(index, partial)
      this.order.push(index)
    }
    return partial
  }

  private assemble(partial: PartialBlock, index: number): ContentBlock {
    if (partial.block) return partial.block
    switch (partial.blockType) {
      case 'text': return { type: 'text', text: partial.text }
      case 'reasoning': return { type: 'reasoning', text: partial.text }
      case 'tool-call': return {
        type: 'tool-call',
        id: partial.toolCallId ?? brandString<'ToolCallId'>(`call-${index}`),
        name: partial.toolCallName ?? '',
        arguments: partial.toolCallArguments,
      }
      default: throw new Error(`cannot assemble incomplete block of type "${partial.blockType}"`)
    }
  }

  /** Invariant accessor: every index in `order` has a partial. */
  private mustGet(index: number): PartialBlock {
    const partial = this.partials.get(index)
    if (!partial) throw new Error(`BlockAssembler invariant violated: no partial for index ${index}`)
    return partial
  }

  /**
   * Settlement: the ONE shared keep/drop decision over all seen blocks.
   * Max-token truncation drops tool calls that cannot be executed safely, and
   * prunes the replay envelope's per-block entries at the same positions; an
   * envelope whose entries do not align with the seen block count is discarded
   * whole. Emitted blocks and replay metadata both derive from this single
   * pass, so they cannot disagree. Idempotent and non-destructive: it reads the
   * push state and writes only the settled results, which `blocks()` and
   * `replayState` refresh on every read.
   */
  assembled(): void {
    const all = this.order.map(index => this.assemble(this.mustGet(index), index))
    const kept = this.finish.kind === 'max-tokens'
      ? all.map(block => block.type !== 'tool-call')
      : undefined
    const blocks = kept === undefined ? all : all.filter((_, position) => kept[position])
    this._blocks = blocks
    const envelope = this._replayState
    if (envelope?.blocks === undefined) {
      this._replay = envelope
      return
    }
    if (envelope.blocks.length !== all.length) {
      this._replay = undefined
      return
    }
    this._replay = kept === undefined || blocks.length === all.length
      ? envelope
      : { response: envelope.response, blocks: envelope.blocks.filter((_, position) => kept[position]) }
  }

  /**
   * Assemble all blocks seen so far, in first-seen stream order: one block per
   * seen index, except that max-token truncation drops tool calls. An open
   * block assembles from its accumulated deltas (an open block of a type that
   * cannot be built from deltas throws).
   */
  blocks(): ContentBlock[] {
    this.assembled()
    return this._blocks
  }

  /**
   * The prefix an interrupted stream can safely finalize: closed and open
   * text/reasoning blocks with non-whitespace content, in stream order. Tool
   * calls are omitted because interruption precedes dispatch; retaining one
   * would require a fabricated result. Open non-text/reasoning blocks are also
   * omitted. Empty when nothing streamed before the interruption.
   */
  interruptedBlocks(): ContentBlock[] {
    return this.order
      .map((index) => {
        const partial = this.mustGet(index)
        const type = partial.block?.type ?? partial.blockType
        if (type !== 'text' && type !== 'reasoning') return undefined
        return this.assemble(partial, index)
      })
      .filter((block): block is ContentBlock =>
        (block?.type === 'text' || block?.type === 'reasoning') && block.text.trim() !== '')
  }

  /** Usage from the `usage` chunk; undefined until one arrives. */
  get usage(): TokenUsage | undefined {
    return this._usage
  }

  /** Finish reason from the `finish` chunk; `{kind:'stop'}` when the stream ended without one. */
  get finish(): FinishReason {
    return this._finish ?? { kind: 'stop' }
  }

  /**
   * Replay metadata from the terminal finish chunk, if any, with per-block
   * entries pruned in step with {@link blocks}. Undefined when the envelope's
   * entries do not align with the seen blocks.
   */
  get replayState(): ReplayEnvelope | undefined {
    this.assembled()
    return this._replay
  }

  /**
   * The assembled assistant message: a frozen assistant-role message over
   * `blocks()` (same settlement), with the caller's provider/model attribution.
   */
  message(source: Omit<ModelMessageSource, 'kind'>): AssistantMessage {
    return createAssistantMessage({ content: this.blocks(), source })
  }
}
