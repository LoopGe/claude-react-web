# Agent Note: Native skill invocation recovery

Status: implemented

## Problem

Native slash invocation kept `/name args` only in the manager's live ring. The provider replaced it with an expanded SKILL.md user event for the model and durable log, so disk replay, resume, fork, and search lost what the user typed. Live slash expansion and the Skill tool also rendered different text, and a root catalog view could bypass the active persona's skill allowlist.

Splitting the user input from the model instruction raises ordering and recovery requirements. A crash may leave only the raw user event, a pre-request write failure must not make uninterrupted and resumed histories disagree, and compaction needs the hidden instruction without turning it into a transcript message.

## Decision

A native slash invocation writes an ordinary raw user event followed immediately by a strict history-only `session/skill` event containing `name`, `body`, and `timestamp`. The body is the canonical `Base directory for this skill` prefix plus the SKILL.md body without frontmatter. Slash arguments remain only in the raw user event. A Skill tool result uses the same canonical body and adds its own `## User Request` suffix only for nonblank arguments.

The hidden event enters user-role model history at its logged position but is not broadcast and does not enter history pages, search, or transcript sequence backfill. Replay-v1 reads the persisted body directly. It never rerenders an invocation from the current catalog, and an older server rejects the unknown event rather than silently dropping it. Existing expanded user events and raw-only crash prefixes remain unchanged.

Each turn captures its effective profile, base tool profile, model, permission mode, and effort before its first asynchronous boundary. After skill discovery completes successfully, it immediately freezes the catalog entries and overrides into an immutable skill snapshot. The available-skills section, Skill tool, slash expansion, and tool array use that frozen view and the previously captured execution fields. Persona changes and reloads affect the next turn, not an in-flight request. The persona allowlist constrains both user and model invocation while `disable-model-invocation` and `user-invocable: false` retain their independent meanings.

Raw user and available skill instruction share one pre-request flush. `runTurn` explicitly acknowledges ownership of the ordered initial messages. Before that acknowledgement, the NativeSession error path appends the same messages to in-memory history exactly once; afterwards, `runTurn` is the sole writer. A failed attempt may therefore flush durably later without starting a model stream, and the next live request and resume replay contain the same failed turn without duplication or automatic retry.

A raw-user fork cut includes its immediately following matching skill event. It does not synthesize an instruction for an incomplete old prefix. Manual compaction and native auto-compaction both use `mergedHistoryForCompaction`: the manager copies the normal main/subagent merged history and inserts durable skill bodies after matching raw-user UUID anchors. Missing anchors produce no orphan instruction, and the projection never writes back to rings, subscribers, transcript sidecars, history pages, or search.

`server/providers/native/e2e-skill-invocation.test.ts` exercises these decisions through SessionManager, the real PermissionBroker, NativeProvider, native logs, and scripted model streams. Coverage includes live/disk/search/fork/resume, policy and next-turn reload, shared canonical bodies, pre-request failure, crash and legacy logs, and both compaction paths with subagent context.

## Alternatives considered

- **Persist only the expanded user event.** This loses the user's actual input and makes live and recovered UI disagree. It also cannot provide raw-command search without inventing a second representation.
- **Store arguments in `session/skill` or append them to the slash body.** This duplicates arguments in model history because the raw user event already contains them. The Skill tool retains its separate result protocol instead of forcing byte-identical slash and tool strings.
- **Rerender instructions from the current skill files during replay.** This makes old requests depend on later edits, deletion, persona changes, and reload timing. Persisting the canonical body gives replay-v1 stable meaning; a future renderer change needs explicit versioning.
- **Repair raw-only crash prefixes or migrate expanded legacy events.** Both require guessing whether an invocation occurred and which definition the model saw. The implementation preserves incomplete and legacy history rather than fabricating instructions or raw commands.
- **Use provider model history as the compact summarizer input.** This would discard the manager's subagent frames. Conversely, using only the ordinary UI merged history would omit hidden instructions. The anchored compaction-only projection preserves both without exposing the instructions as transcript content.
- **Let the error path always append initial messages.** This duplicates messages when failure occurs after `runTurn` has taken ownership. The explicit ownership hand-off gives each failure boundary one writer.

## Consequences

The log stores two ordered events for a successful slash invocation and rejects downgrade to a server that does not know `session/skill`. In exchange, live and recovered UI retain the raw command, search works on the user's text, and model requests use the same frozen instruction before and after restart.

A failed pre-request turn remains durable consumed-turn history even though no model stream started. Later turns can include that failed attempt, but the system does not claim the model saw it or replay the request automatically.

Attachment file-block fidelity, cross-reload-generation races, plugin skills, and forked Skill execution remain unresolved and are not claimed by this decision. Controller ownership of the final whole-workstream review and any user-authorized push also remains separate from this implementation record.

The Stage A [native agent profile presets](2026-11-11-native-agent-profile-presets.md) and Stage B [native subagent transcripts](2026-11-12-native-subagent-transcripts.md) decisions remain authoritative for their mechanisms. This note supersedes only their earlier statements that Stage C `session/skill` recovery was still pending.
