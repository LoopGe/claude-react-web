# Agent Notes

One kind of design doc lives here. An **Agent Note** records a decision or proposal that affects this codebase — the _why_ and _what we gave up_, the parts code and docs can't carry. This file defines where notes live, when to write one, and the in-file format.

> Claude Code does not discover this directory on its own. `CLAUDE.md` is the entry point; these are ordinary committed Markdown files.

## Layout and naming

Every note has two axes, both encoded in its **path** — `{lifecycle}/{class}/yyyy-mm-dd-topic-title.md`:

- **Lifecycle** (the top-level folder) is the note's status, and a note moves between folders as that status changes:
  - **`proposed/`** — proposals reviewed before implementation; not yet built (or only partly).
  - **`implemented/`** — the decision shipped. The file records what was decided and what was rejected, and is **kept current with what actually shipped**: when the code later moves a file, renames a module, or changes a key/default, the note is updated in the same change to match (facts only — paths, names, structure — not the decision itself).
  - **`rejected/`** — the proposal was considered and declined. Keep it only while its rationale prevents a tempting, meaningful mistake; otherwise delete the file.
- **Class** (the nested folder) is the _kind_ of decision. The set is closed; the verifier rejects any other folder:

| Class            | What it covers                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------ |
| `feature`        | A new user- or model-facing capability.                                                                      |
| `bug-fix`        | Corrects a defect or closes a gap a postmortem surfaced.                                                     |
| `simplification` | Removes code, behavior, or surface area without adding a capability.                                         |
| `architecture`   | A structural decision about the shipped source — how modules relate, what the runtime vocabulary is.         |
| `process`        | Tooling, policy, or workflow around the code — gates, package manager, release steps — not runtime behavior. |
| `testing`        | Test infrastructure and strategy.                                                                            |

The date in the filename is when the topic was **first proposed**. Cross-references between notes use relative Markdown links (`[topic](../../implemented/architecture/2026-…-….md)`) — never bare prose or numbers — so they are mechanically checkable and survive moves between folders.

The lifecycle tree is the working inventory: browse the lifecycle/class folders or search the repository. Do not add a centralized `INDEX.md`: it duplicates path metadata and makes unrelated note changes contend on one generated file.

## When to write one

Add or update an Agent Note in the same change only for lasting decision rationale that code, tests, and existing documentation do not explain. A proposal for substantial future work starts in `proposed/`; a decision already made starts in `implemented/`. Pick the class folder that matches the decision.

Updating the note that already owns the decision satisfies the rule; do not create a duplicate. Mechanical or local edits, including UI presentation and interaction changes, are exempt. An Agent Note is never edited into a _different decision_: supersede it with a new one and cross-link both.

**Every new note triggers a supersession check.** Search the active tree for older notes covering the same decision or mechanism, and cross-link partial supersessions.

## The file format

### The header block

The first three lines of every note are exactly:

```markdown
# Agent Note: <title>

Status: <status>
```

followed by a blank line. The `Status:` value must agree with the lifecycle folder the file sits in — the verifier cross-checks them:

- `Status: proposed`
- `Status: implemented`
- `Status: rejected — <why, in one line>`

The status carries no dates and no parentheticals: the filename holds the first-proposed date, git holds everything else. The rejection reason is the one status with content, because a rejected note's verdict is the fact readers come for.

### The body skeleton

Every note opens its body with `## Problem` — the motivation, written to stand without the solution. What follows depends on the lifecycle; recurring sections use these canonical names and nothing else, while genuinely bespoke technical sections (package topology, wire contracts, schemas) remain free-form between the required ones.

**`proposed/`**

```markdown
## Problem

## Proposal

…bespoke sections…

## Alternatives considered

## Acceptance criteria

## Risks
```

`## Proposal` is the intended change and may legitimately speak in the future tense — plans, migration steps, and open questions belong here while the work is unbuilt. `## Acceptance criteria` says what observable state means done. `## Risks` covers both what could go wrong and what the change knowingly gives up.

**`implemented/`**

```markdown
## Problem

## Decision

…bespoke sections…

## Alternatives considered

## Consequences
```

`## Decision` describes shipped reality in the present tense, and the whole file is kept current with it. `## Consequences` records what the trade-off cost **and** bought. Proposal-era headings are spec-speak here and the verifier rejects them: `## Proposal`, `## Plan`, `## Migration plan`, and `## Acceptance criteria` may not appear in an implemented note. A `## Testing`, `## Deferred`, or `## Related` section is fine where it states present-tense fact.

**`rejected/`**

A rejected note is the proposal, frozen: it keeps whatever proposal-time sections it had (including `## Acceptance criteria` or `## Plan`), and the verdict lives on the `Status:` line. The header block, the `## Problem` opener, a `## Proposal` section, and the Alternatives-considered mandate below apply.

### Alternatives considered — mandatory

Every note carries an `## Alternatives considered` section: each genuine alternative and why it lost, one bold-led paragraph per alternative or a `### Why not <X>?` subsection per contested one. A decision recorded without what it beat invites re-litigation — the failure Agent Notes exist to prevent.

Alternatives are recorded, never invented.

### Moving between lifecycles

Moving a file between lifecycle folders means updating the `Status:` line and re-satisfying that folder's skeleton in the same change — the verifier fails the move otherwise. Concretely, `proposed/` → `implemented/` rewrites `## Proposal` into a present-tense `## Decision`, folds `## Acceptance criteria` and `## Risks` into `## Consequences` (or a present-tense `## Testing`/`## Verification` section for what now pins the behavior), and drops plans in favor of what shipped. `proposed/` → `rejected/` only adds the reason to the `Status:` line and freezes the file.

### Chinese counterparts

A `.zh.md` sibling mirrors its English counterpart's structure section for section. It is optional in this repository; when present, the machine-checked header tokens (`# Agent Note: ` and the `Status:` line) stay in English verbatim, and the verifier checks that its status line matches the English sibling and that both files have the same number of `##` sections.

## Validation

`npm run verify:agent-notes` (`scripts/verify-agent-notes.mjs`) checks the closed lifecycle/class tree, filename dates, the header block, status/folder agreement, the required sections and their order, relative links that resolve, and — for a `.zh.md` sibling — a matching status line and `##` section count. It runs as part of `npm run verify` and the CI `verify` job. No index is generated.
