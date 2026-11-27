# Agent Note: Native auto-memory — learned-memory loop with write isolation

Status: implemented

## Problem

The native provider had no learned-memory layer: `supportsMemory: false`, and
`applyFlagSettings` rejected the three memory keys (`autoMemoryEnabled` /
`autoMemoryDirectory` / `autoDreamEnabled`). A native session could not store a
fact it learned, recall it on a later turn, or consolidate its memory store —
while the claude provider had the full loop. The host already carried everything
around the gap: the settings/REST/UI surface, the fork/resume intent carriage,
and the `system/memory_recall` frame renderer are provider-agnostic
([research](../../../../docs/research/2026-11-27-memory-systems-research.md),
RS §3). Only the native subsystems were missing.

Two product decisions bound the design ([spec](../../../../docs/superpowers/specs/2026-11-27-native-memory-design.md)):
**write isolation, read compatibility** — native writes its own memory store and
never lands a write in the claude config dir, but recalls the same-cwd claude
memory read-only; and **full closed loop** — store, write discipline, recall and
auto-dream consolidation all ship, not phased.

## Decision

A new host port (`NativeAutoMemoryPort`, `server/providers/native-host-auto-memory.ts`)
owns all filesystem concerns — directory resolution, the CLI-exact cwd slug,
candidate enumeration with format-drift tolerance, bounded reads, the dream
state file and the touched-session scan. The neutral core owns recall
timing/budget (`native/memory.ts`) and dream orchestration (`native/dream.ts`);
the host adapter projects a new `memory/recall` operational frame to the SDK
`system/memory_recall` shape. The core never imports a host service or the SDK
(the [host-service ports](../architecture/2026-11-19-native-host-service-ports.md)
and [provider-seam neutralization](../architecture/2026-11-18-provider-seam-neutralization.md)
discipline, pinned by `neutrality.test.ts` / `host-free.test.ts`). This is the
eighth port, independent of the instruction-chain `NativeMemoryPort` — learned
memory and instruction memory are separate subsystems, as they are in the CLI
([instruction-memory note](2026-11-27-native-memory-and-behavior.md)).

### Dual-track persistence, zero new v3 event words

Recall persists on two existing tracks, neither of which adds a `SessionEventMap`
word (the v3 event set is closed; a new word costs parser validation + projection
+ migration across the whole chain):

1. **Model-visible content** rides the `session/supplement` event word with a
   memory-specific wrap (`[RECALLED MEMORY] …`, `formatMemoryRecallInstruction`).
   The core enqueues a memory-kind supplement at turn start; the loop drains it
   before the first model round. That event word's replay already feeds model
   history, compact input and fork seeds, and its transcript projection is null —
   so the recall text reaches the model on live, replay and resume with no wire
   or projection change. It is deliberately **not** appended into the
   `user/message` payload: that would fork the live user bubble from the sidecar
   copy and surface the recall text inside the user's bubble on reload.
2. **The user-visible card** rides the live-frame + sidecar app-only track. The
   adapter projects `memory/recall` to `system/memory_recall`; the pump admits it
   to the ring and the seq sidecar, and the existing renderer draws it. Disk
   consistency comes from the sidecar layer (RS §8/§9.5 verified), so a cold
   restart hydrates the card at the same seq with the same shape — no
   `session/memory-recall` event word needed.

The two tracks share one uuid (the supplement entry and the live frame), so the
durable injection and the card pair by identity. `mode` is always `'select'` and
`scope` always `'personal'` (SDK union constraints); the own-vs-claude source is
distinguished by path, not by extending the scope union. File-backed entries
carry no content (the SDK contract; the renderer lazy-loads by path).

### Write isolation in three layers, read compatibility

The invariant "native writes never land in the claude config dir" is enforced at
three independent layers, so no single input class defeats it:

1. **Directory root separation** — the default own root is
   `<stateDir>/native-memory/<cwd-slug>/`, physically separate from the claude
   store under `~/.claude/projects/`. The slug is the CLI's sanitized-cwd
   encoding (CLI-verified, RS §2.2) so a user can line the two stores up by eye.
2. **Override realpath validation** — an `autoMemoryDirectory` override whose
   realpath lands inside `claudeConfigDir()` is rejected with `HttpError 400`
   before anything is created (symlink/junction aliases included, via
   nearest-existing-ancestor realpath). This guards the override input class the
   default root's physical separation cannot.
3. **Broker write-exemption scope** — the root-scoped permission exemption
   auto-allows a write only inside the session's resolved `own` root; the claude
   compat root never grants a write exemption (`isMemoryRootWrite` checks `own`
   only). Containment is realpath-based, so a symlink inside a root cannot escape.

The manager resolves these roots only for a provider that advertises the
`hostAutoMemoryStore` capability (native) — a capability gate, not a provider-name
special-case, per the [provider-seam neutralization](../architecture/2026-11-18-provider-seam-neutralization.md)
pin. A provider that manages its own memory in the CLI config dir (claude) leaves
`Session.memoryRoots` undefined, so the exemption stays inert for it.

Reads are compatible: recall enumerates `[ownDir, claudeDir]`, and the broker
read exemption covers both. The claude store is a compatibility target, not a
controlled interface — unknown frontmatter fields are tolerated and malformed
files skipped, never thrown into the turn path (spec §5.3).

### Dream consolidation is per-cwd

The memory root is per-cwd, so dream is per-cwd: the trigger count, the
single-flight lease and the completion timestamp are all scoped to the cwd.
A turn-end check fires a dream when the cwd is at least `nativeDreamAfterMs`
(default 24 h) past its last dream AND at least `nativeDreamSessionCount`
(default 5) same-cwd native sessions were touched since (config-overridable;
`autoDreamEnabled` is the master switch). The dream is a fire-and-forget
background subagent confined to Read/Write/Edit, launched programmatically and
immediately backgrounded so it never blocks the user turn. Its containment roots
are write-only `ownDir`, read `ownDir` plus the native session-log tree (the
consolidation source). The lease is process-local (a crash resets it and the next
window retries); completion timestamps persist in
`<stateDir>/native-memory/dream-state.json`. Failure posture: log + release the
lease, never surface an error into the user turn.

The broker's memory-root **read** exemption covers the native session-log tree
(`sessionLogs` root) as well as the memory stores. This is what lets the dream
`Read` its consolidation source without stalling on an interactive prompt in
default mode — the full-chain e2e exposed that the exemption originally covered
only `own` + `claude`, so a default-mode dream parked on its first session-log
Read (the unit tests had masked this with `bypassPermissions`). The broadening
grants the main session no new reach: its tool-layer containment already refuses
the session-log tree (Read's read roots are `own` + `claude`; Grep/Glob/LS are
cwd-only), so only the dream — whose read roots include that tree — benefits.
The session-log root is read-only and never a write root.

### Settings parity, disable posture, prompt reach

The three memory keys have two doors — the dedicated `/memory` route
(`setMemorySettings`) and the generic `/settings` route (`applySettings`).
Both run one shared normalisation (`memoryFlagsOf`: present keys only, null
clears, directory trimmed / whitespace-only → null) and one shared mirror
(`mirrorMemorySettings`: `s.memory` + `refreshMemoryRoots` + persist), so the
live core, the persisted meta and the broker roots cannot diverge by door.
The generic door applies the same type guards as the dedicated route (the
env/agent second-door precedent).

The spawn/settings validation seed fails turns loudly on a bad directory
override until a settings change re-validates it — and disabling the feature
(`autoMemoryEnabled: false`) skips the seed await entirely: every memory
consumer (prompt section, recall, dream) is gated off when disabled, so
turning the feature off stops its errors. The directory-change heal stays.

The `# Memory` write-discipline section is main-turn-only (spec §7.1 excludes
subagent turns from recall). The nested Agent/Task system omits it: nested
tools are cwd-contained (no `memoryRoots`), so the section would name a dir
the run cannot reach. The dream run keeps it — its own loop deps carry
write-`ownDir` roots. Candidate enumeration reads only an 8 KiB head of each
file for frontmatter (the scan runs every main turn); a closing delimiter
beyond the head reads as malformed and the file is skipped, the same contract
as a genuinely missing delimiter.

## Alternatives considered

**A new `session/memory-recall` v3 event word.** The intuitive way to persist the
card durably, but the v3 event set is closed and a new word forces parser
validation, host projection, migration and replay handling across the chain. The
sidecar app-only layer already supplies disk consistency for any renderable live
frame (RS §9.5 verified), and the supplement word already carries the model
history — so both persistence needs are met with zero new words. The fork RS §4.4
flagged ("new event word vs sidecar") closes on the sidecar side.

**A global dream.** A single global trigger/lock/`lastDreamAt` is simpler, but a
global dream would review project A's sessions while writing only A's directory,
and a global `lastDreamAt` would suppress B's and C's own consolidation. Per-cwd
scoping matches the per-cwd memory root and the CLI's per-project lock precedent
(RS §2.5).

**MCP outsourcing (the DSH route).** DSH ships no auto-memory and recommends
third-party memory MCP servers (RS §1.4/§4.5). That is a different product shape
— an external server the user must install and trust — and would not give the
native provider the integrated store/recall/dream loop the claude provider has.
Rejected as out of scope for provider parity.

**A deterministic fallback ranking when the aux selector fails.** Tempting for
robustness, but it is an unproven fallback path (repo convention: no speculative
fallbacks). Degradation is skip-the-turn: an aux failure, abort or malformed
selection means no recall this turn, the turn proceeds, and there is no guessed
ranking. The 2 s deadline and the 61440-byte session budget are CLI-measured
constants (RS §7.3), not invented.

**Appending recall text literally into the user message.** Would persist with no
new event word, but forks the live user bubble from the sidecar copy and shows the
recall text inside the user's bubble on reload (reconcile canonical content wins).
The supplement track avoids both.

## Consequences

Native sessions have the full learned-memory loop at parity with claude: store,
write discipline, turn-start recall with a durable card, and per-cwd dream
consolidation. The host settings/UI surface unlocks automatically through
`supportsMemory: true`. Write isolation holds by construction across the three
layers, and the claude store is read-compatible without being writable.

The cost is a host port plus two core modules that must track CLI conventions
(slug, layout, budgets) as a compatibility target rather than a controlled
interface, and a dream read root the broker exemption must know about. The
dual-track design keeps the v3 event set closed and the wire projection unchanged,
but it means the card's durability lives in the sidecar layer (provider-agnostic)
rather than the provider log — a reader looking only at the native log will not
find the card, by design.

Recall failure is fail-soft (skip the turn), so a slow or broken aux selector
never blocks the user; the trade-off is that a turn may silently recall nothing.
Dream failure is likewise silent (log + release), so a wedged consolidation
retries next window rather than surfacing — the trade-off is that consolidation
can lag without a user-visible signal.

### Testing

`server/providers/native/e2e-memory.test.ts` drives the full chain through the
real `SessionManager`, permission broker, host auto-memory port and Write/Read
tools — only the Anthropic stream (`_testStream`) and the aux LLM port are mocked.
It pins: learn → remember → recall (a real Write stores a memory, a fresh session
recalls it into a supplement + card + model-history replay); claude read-compat
with write isolation (a claude-store memory is recalled, a claude-dir Write is
denied, and the claude dir is byte-for-byte unchanged after a turn + dream);
per-cwd dream consolidation reading session logs and writing only the own dir;
dream failure releasing the lease so a later window retries; restart survival (a
second manager cold-reads the card and replays the recall); and override rejection
(a claude-dir override 400s with `session.memory` unchanged). Unit pins cover the
broker read/write exemption (including the session-log read root and the
never-exempt claude write), the host port, the recall state machine and the dream
trigger; `neutrality.test.ts` / `host-free.test.ts` pin the core boundary.

## Related

- [Native memory loading and behavior guidance](2026-11-27-native-memory-and-behavior.md) — the instruction-memory subsystem auto-memory sits beside.
- [Native host service ports](../architecture/2026-11-19-native-host-service-ports.md) and [provider seam neutralization](../architecture/2026-11-18-provider-seam-neutralization.md) — the boundary the auto-memory port respects.
- [Research: memory systems](../../../../docs/research/2026-11-27-memory-systems-research.md) (RS) — the CLI/DSH/CRW evidence base.
- [Design spec](../../../../docs/superpowers/specs/2026-11-27-native-memory-design.md) and [implementation plan](../../../../docs/superpowers/plans/2026-11-27-native-auto-memory.md).