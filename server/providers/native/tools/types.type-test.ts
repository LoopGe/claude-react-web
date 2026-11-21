// Compile-time pin for the tools' neutral result vocabulary (Task 17).
// Isolated from the production programs like ../vocabulary/*.type-test.ts:
// tsconfig.node.json excludes *.type-test.ts and tsconfig.type-test.json
// (chained into `npm run typecheck`) compiles this file, so the assertions
// genuinely typecheck without widening anything the production programs see.
// The name falls OUTSIDE vitest's `*.test.ts` include — nothing here executes.
import { expectTypeOf } from 'vitest'
import type { ContentBlock, FileBlock, TextBlock } from '../vocabulary/types.js'
import type { ToolResultMessageInput } from '../vocabulary/message.js'
import type { NativeFileAttachment } from '../../../../shared/attachment-types.js'
import type { ToolDef, ToolFileBlock, ToolOutcome } from './types.js'

// A tool outcome's structured content IS neutral vocabulary content: the loop
// hands it to createToolResultMessage with no translation step.
expectTypeOf<NonNullable<ToolOutcome['content']>>().toMatchTypeOf<readonly ContentBlock[]>()
expectTypeOf<NonNullable<ToolOutcome['content']>>().toMatchTypeOf<ToolResultMessageInput['content']>()
expectTypeOf<TextBlock>().toMatchTypeOf<NonNullable<ToolOutcome['content']>[number]>()

// A tool file occurrence is a vocabulary FileBlock whose attachment keeps the
// FULL resolved registry facts (path / mediaType / modelForm) — a structural
// superset of the public FileAttachmentRef — so the wire adapter can still
// project it to handle text or a PDF document on every later API round.
expectTypeOf<ToolFileBlock>().toMatchTypeOf<FileBlock>()
expectTypeOf<ToolFileBlock>().toMatchTypeOf<NonNullable<ToolOutcome['content']>[number]>()
expectTypeOf<ToolFileBlock['attachment']>().toEqualTypeOf<NativeFileAttachment>()
expectTypeOf<ToolFileBlock['attachment']['modelForm']>().toEqualTypeOf<'handle' | 'pdf-document'>()
expectTypeOf<ToolFileBlock['attachment']['path']>().toEqualTypeOf<string>()

// Every tool — not just the attachment reader — returns that neutral outcome.
expectTypeOf<ToolDef['run']>().returns.toEqualTypeOf<Promise<ToolOutcome>>()
