// Compile-time merge-extensibility pin, ISOLATED from the production programs.
// Declaration merging is global to a compilation: the fake producer kind
// below widens MessageSource in EVERY file of the program that contains this
// one. tsconfig.node.json and desktop/tsconfig.json therefore EXCLUDE
// *.type-test.ts, and this file is typechecked by tsconfig.type-test.json
// (chained into `npm run typecheck`) instead — so the pin genuinely compiles,
// but the production MessageSource keeps exactly its four core kinds for
// exhaustive consumers (e.g. the host adapter's switch + assertNever).
//
// Pure type-level file: the name deliberately falls OUTSIDE vitest's
// `*.test.ts` include ('-test.ts' is not '.test.ts'), so nothing here executes
// at runtime — declaration merging has no runtime semantics to test. The
// runtime discrimination of the core kinds is covered by source.test.ts,
// whose default-less exhaustive switch doubles as a leak detector: any
// augmentation reaching the production program breaks its compile (TS2366).
import { expectTypeOf } from 'vitest'
import type { MessageSource, MessageSourceMap, ModelMessageSource } from './source.js'

// A producer module declares its OWN source kind — there is no catch-all kind
// in the core map. This is the declaration-merging mechanism under test.
interface TestProducerSource {
  kind: 'test-producer'
  label: string
}
declare module './source.js' {
  interface MessageSourceMap {
    'test-producer': TestProducerSource
  }
}

// The merged kind lands in the map, and the derived union widens to it.
expectTypeOf<MessageSourceMap['test-producer']>().toEqualTypeOf<TestProducerSource>()
expectTypeOf<TestProducerSource>().toMatchTypeOf<MessageSource>()

// Merging ADDS a kind — the core kinds stay assignable.
expectTypeOf<ModelMessageSource>().toMatchTypeOf<MessageSource>()
expectTypeOf<{ kind: 'user' }>().toMatchTypeOf<MessageSource>()

// The widened union still discriminates: the merged kind narrows to its shape.
declare const widened: MessageSource
if (widened.kind === 'test-producer') {
  expectTypeOf(widened).toEqualTypeOf<TestProducerSource>()
  expectTypeOf(widened.label).toEqualTypeOf<string>()
}
