// server/providers/native/explore.test.ts
import { describe, expect, it } from 'vitest'
import {
  EXPLORE_AGENT_INSTRUCTION,
  EXPLORE_AGENT_NAME,
  filterExploreTools,
} from './explore.js'
import type { ToolDef } from './tools/types.js'
import { createAttachmentReadTool } from './tools/attachment-read.js'
import { NativeAttachmentReferenceIndex } from '../../attachment-reference-index.js'
import { UploadStore } from '../../upload-store.js'

function tool(name: string, readOnlyHint?: unknown): ToolDef {
  return {
    name,
    description: `${name} description`,
    guidance: '',
    promptOrder: 1,
    schema: {},
    ...(readOnlyHint === undefined ? {} : { readOnlyHint }),
    async run() { return { text: 'ok' } },
  } as ToolDef
}

describe('Explore agent role', () => {
  it('uses the reserved case-sensitive name and fixed read-only instruction', () => {
    expect(EXPLORE_AGENT_NAME).toBe('Explore')
    expect(EXPLORE_AGENT_INSTRUCTION).toBe(
      'Explore the codebase read-only. Use available read-only tools to answer with concrete file references; do not modify files or run state-changing tools.',
    )
  })

  it('keeps only tools whose readOnlyHint is exactly true', () => {
    const read = tool('Read', true)
    const write = tool('Write', false)
    const undeclared = tool('Undeclared')
    const truthyString = tool('TruthString', 'true')
    const truthyNumber = tool('TruthNumber', 1)

    expect(filterExploreTools([read, write, undeclared, truthyString, truthyNumber])).toEqual([read])
  })

  it('keeps AttachmentRead in the read-only role without changing other tool metadata', () => {
    const stateDir = process.cwd()
    const attachmentRead = createAttachmentReadTool({
      uploadStore: new UploadStore({ stateDir }),
      stateDir,
      referenceIndex: new NativeAttachmentReferenceIndex({ stateDir }),
      sessionId: 'explore-session',
    })
    const read = tool('Read', true)
    const write = tool('Write', false)

    expect(filterExploreTools([read, attachmentRead, write])).toEqual([read, attachmentRead])
    expect(attachmentRead.readOnlyHint).toBe(true)
  })

  it('returns a detached array without rewriting tool metadata', () => {
    const read = tool('Read', true)
    const input = [read]

    const output = filterExploreTools(input)

    expect(output).not.toBe(input)
    expect(output[0]).toBe(read)
    expect(output[0].readOnlyHint).toBe(true)
  })
})
