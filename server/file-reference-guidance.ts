import type { Options } from '@anthropic-ai/claude-agent-sdk'

/** System-prompt guidance for the composer's @file/@folder references.
 *  The model receives the references as plain `@path` text in the user turn;
 *  this section tells it what those tokens mean and how to act on them.
 *  Adapted from DSH's FILE_REFERENCE_PROMPT.
 *
 *  Applied to EVERY spawn path of both providers: the claude provider via
 *  `Options.systemPrompt` preset-append (see withFileReferenceGuidance), the
 *  native provider via `CreateSessionOptions.systemPromptAppend`.
 *
 *  Persona safety (probe-verified against the pinned CLI 0.3.311): the CLI's
 *  system-prompt composer uses a main-thread agent's (`Options.agent`) own
 *  prompt as the BASE and appends `appendSystemPrompt` after it — a
 *  preset-append therefore composes with a persona, never replaces it. A
 *  live spawn with both an agent persona and a preset-append reported both
 *  texts; the agent-only control reported just the persona. */
export const FILE_REFERENCE_GUIDANCE = `## Referenced paths (@ tokens)

When the user's message contains an @path token (such as @src/app.ts or
@docs/), it is a file or directory path the user explicitly referenced.
- Use the Read tool to read a referenced file whenever its contents are
  needed to answer the request or decide what to do.
- Do not claim to have inspected a referenced path before actually reading
  it.
- A trailing slash marks a directory (such as @src/utils/). When its
  contents matter, list the directory first and then read the relevant
  files.`

/** Append FILE_REFERENCE_GUIDANCE to any `Options.systemPrompt` shape,
 *  preserving everything the caller supplied:
 *  - absent → the claude_code preset-append shape;
 *  - preset → guidance appended after the existing `append` (this is how the
 *    Side Chat instructions compose with it);
 *  - string / string[] / custom → the caller's prompt kept verbatim as the
 *    prefix, guidance appended after it (normalized to the custom shape).
 *
 *  Every result carries `snapshot: false`: the guidance is app-managed text
 *  that may change across versions, and a recorded (snapshot:true) prompt is
 *  replayed verbatim on resume — the same rationale as the Side Chat
 *  instructions' preset. The caller's prompt CONTENT is never altered, only
 *  the recording semantics. */
export function withFileReferenceGuidance(systemPrompt: Options['systemPrompt']): Options['systemPrompt'] {
  if (systemPrompt === undefined) {
    return { type: 'preset', preset: 'claude_code', append: FILE_REFERENCE_GUIDANCE, snapshot: false }
  }
  if (typeof systemPrompt === 'string') {
    return { type: 'custom', prompt: `${systemPrompt}\n\n${FILE_REFERENCE_GUIDANCE}`, snapshot: false }
  }
  if (Array.isArray(systemPrompt)) {
    return { type: 'custom', prompt: [...systemPrompt, FILE_REFERENCE_GUIDANCE], snapshot: false }
  }
  if (systemPrompt.type === 'preset') {
    return {
      ...systemPrompt,
      append: systemPrompt.append ? `${systemPrompt.append}\n\n${FILE_REFERENCE_GUIDANCE}` : FILE_REFERENCE_GUIDANCE,
      snapshot: false,
    }
  }
  const prompt = typeof systemPrompt.prompt === 'string'
    ? `${systemPrompt.prompt}\n\n${FILE_REFERENCE_GUIDANCE}`
    : [...systemPrompt.prompt, FILE_REFERENCE_GUIDANCE]
  return { ...systemPrompt, prompt, snapshot: false }
}