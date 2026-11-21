// Branded string ids for the neutral vocabulary (mirrors DSH
// packages/util/brand). A brand is a phantom property keyed by a unique
// symbol: it exists only in the type system, so a branded id is still a
// plain string at runtime, but a bare string can never pose as one.

declare const BRAND: unique symbol

export type Branded<B extends string> = string & { readonly [BRAND]: B }

/** Mint a branded id from a raw string. The only way to obtain a branded
 *  value — callers name the brand explicitly or via the contextual type. */
export function brandString<B extends string>(s: string): Branded<B> {
  return s as Branded<B>
}

export type MessageId = Branded<'MessageId'>
export type ToolCallId = Branded<'ToolCallId'>
