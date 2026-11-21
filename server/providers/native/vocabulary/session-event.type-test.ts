// Compile-time merge-extensibility pin, ISOLATED from the production programs
// (same mechanism as source.type-test.ts — see its header): declaration
// merging is global to a compilation, so tsconfig.node.json and
// desktop/tsconfig.json EXCLUDE *.type-test.ts and tsconfig.type-test.json
// (chained into `npm run typecheck`) compiles this file instead. The fake
// durable key below widens SessionEventMap ONLY in this program; production
// NativeSessionEvent keeps exactly its core keys for exhaustive consumers.
//
// Pure type-level file: the name deliberately falls OUTSIDE vitest's
// `*.test.ts` include ('-test.ts' is not '.test.ts'), so nothing here executes
// at runtime. The runtime discrimination of the core keys is covered by
// session-event.test.ts, whose default-less exhaustive fold doubles as a leak
// detector: any augmentation reaching the production program breaks its
// compile.
import { expectTypeOf } from 'vitest'
import type { NativeSessionEvent, SessionEvent, SessionEventMap } from './session-event.js'

// An extension declares its OWN durable event key — the map is an interface
// precisely so this merge works without touching the core module.
interface TestDurableProbe {
  probe: string
}
declare module './session-event.js' {
  interface SessionEventMap {
    'test/durable-probe': TestDurableProbe
  }
}

// The merged key lands in the map with its payload.
expectTypeOf<SessionEventMap['test/durable-probe']>().toEqualTypeOf<TestDurableProbe>()

// The derived union widens to the merged key and still discriminates: the
// merged key narrows to its own envelope + payload.
declare const widened: NativeSessionEvent
if (widened.type === 'test/durable-probe') {
  expectTypeOf(widened).toEqualTypeOf<SessionEvent<'test/durable-probe'>>()
  expectTypeOf(widened.data).toEqualTypeOf<TestDurableProbe>()
  expectTypeOf(widened.seq).toEqualTypeOf<number>()
}

// Merging ADDS a key — the core keys stay present and discriminated.
expectTypeOf<Extract<NativeSessionEvent, { type: 'user/message' }>>().not.toBeNever()
expectTypeOf<Extract<NativeSessionEvent, { type: 'session/agent' }>>().not.toBeNever()
expectTypeOf<SessionEvent<'turn/end'>>().toEqualTypeOf<Extract<NativeSessionEvent, { type: 'turn/end' }>>()
