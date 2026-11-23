// server/file-reference-guidance.test.ts
//
// Unit pins for the @file/@folder reference guidance: the constant's content
// contract and the pure composition helper that appends it to every
// `Options.systemPrompt` shape without replacing what the caller supplied.
//
// The composition strategy (preset-append, never a custom-prompt replacement)
// is probe-backed: the pinned CLI (0.3.311) applies `appendSystemPrompt` AFTER
// the main-thread agent's own prompt (its system-prompt composer keeps the
// agent prompt as the base and appends the append text as the last section),
// so a preset-append carries guidance alongside a persona, never over it.
// Verified live: an `Options.agent` persona session spawned with a
// preset-append reported BOTH its persona marker and the append marker.

import { describe, expect, it } from 'vitest'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import { FILE_REFERENCE_GUIDANCE, withFileReferenceGuidance } from './file-reference-guidance.js'

type SystemPrompt = Options['systemPrompt']

describe('FILE_REFERENCE_GUIDANCE', () => {
  it('tells the model @ tokens are user-referenced paths to read, not claim', () => {
    expect(FILE_REFERENCE_GUIDANCE).toContain('@')
    // Read when contents are needed.
    expect(FILE_REFERENCE_GUIDANCE).toMatch(/Read tool/)
    // Never claim inspection before reading.
    expect(FILE_REFERENCE_GUIDANCE).toMatch(/before (actually )?reading/i)
    // Trailing slash = directory; list it when contents matter.
    expect(FILE_REFERENCE_GUIDANCE).toMatch(/trailing slash/i)
    expect(FILE_REFERENCE_GUIDANCE).toMatch(/directory/i)
    expect(FILE_REFERENCE_GUIDANCE).toMatch(/list/i)
  })
})

describe('withFileReferenceGuidance', () => {
  it('turns an absent systemPrompt into the claude_code preset-append shape', () => {
    expect(withFileReferenceGuidance(undefined)).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: FILE_REFERENCE_GUIDANCE,
      snapshot: false,
    })
  })

  it('appends after an existing preset append (Side Chat instructions compose)', () => {
    const existing = 'You are in a side conversation, not the main thread.'
    const out = withFileReferenceGuidance({
      type: 'preset',
      preset: 'claude_code',
      append: existing,
      snapshot: false,
    })
    expect(out).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: `${existing}\n\n${FILE_REFERENCE_GUIDANCE}`,
      snapshot: false,
    })
  })

  it('fills an append-less preset and keeps its other fields', () => {
    const out = withFileReferenceGuidance({
      type: 'preset',
      preset: 'claude_code',
      excludeDynamicSections: true,
    })
    expect(out).toEqual({
      type: 'preset',
      preset: 'claude_code',
      excludeDynamicSections: true,
      append: FILE_REFERENCE_GUIDANCE,
      snapshot: false,
    })
  })

  it('keeps a caller-supplied string prompt as the prefix of a custom prompt', () => {
    const out = withFileReferenceGuidance('CUSTOM-USER-PROMPT')
    expect(out).toEqual({
      type: 'custom',
      prompt: `CUSTOM-USER-PROMPT\n\n${FILE_REFERENCE_GUIDANCE}`,
      snapshot: false,
    })
  })

  it('keeps a caller-supplied string[] prompt and appends guidance as the last block', () => {
    const out = withFileReferenceGuidance(['BLOCK-A', 'BLOCK-B'])
    expect(out).toEqual({
      type: 'custom',
      prompt: ['BLOCK-A', 'BLOCK-B', FILE_REFERENCE_GUIDANCE],
      snapshot: false,
    })
  })

  it('composes onto a custom object prompt (string and array forms)', () => {
    expect(withFileReferenceGuidance({ type: 'custom', prompt: 'CUSTOM', snapshot: true })).toEqual({
      type: 'custom',
      prompt: `CUSTOM\n\n${FILE_REFERENCE_GUIDANCE}`,
      snapshot: false,
    })
    expect(withFileReferenceGuidance({ type: 'custom', prompt: ['A'] })).toEqual({
      type: 'custom',
      prompt: ['A', FILE_REFERENCE_GUIDANCE],
      snapshot: false,
    })
  })

  it('renders fresh on every request (snapshot: false) so guidance updates survive resume', () => {
    // The SDK records a snapshot:true prompt at first request and replays it
    // verbatim on resume — an app-managed append must opt out, exactly like
    // the Side Chat instructions do.
    const shapes: SystemPrompt[] = [
      undefined,
      'CUSTOM',
      ['A'],
      { type: 'custom', prompt: 'CUSTOM', snapshot: true },
      { type: 'preset', preset: 'claude_code', append: 'X', snapshot: true },
    ]
    for (const shape of shapes) {
      const out = withFileReferenceGuidance(shape) as { snapshot?: boolean }
      expect(out.snapshot).toBe(false)
    }
  })

  it('does not mutate the input', () => {
    const preset: SystemPrompt = { type: 'preset', preset: 'claude_code', append: 'X' }
    const custom: SystemPrompt = { type: 'custom', prompt: ['A'] }
    const arr: string[] = ['A', 'B']
    withFileReferenceGuidance(preset)
    withFileReferenceGuidance(custom)
    withFileReferenceGuidance(arr)
    expect(preset).toEqual({ type: 'preset', preset: 'claude_code', append: 'X' })
    expect(custom).toEqual({ type: 'custom', prompt: ['A'] })
    expect(arr).toEqual(['A', 'B'])
  })
})
