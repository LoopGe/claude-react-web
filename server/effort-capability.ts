// Decides which reasoning-effort levels a model supports, keyed off the
// model id string rather than the SDK's supportedModels() report.
//
// Why not the SDK? On gateway/proxy deployments the SDK's supportedModels()
// returns gateway aliases (default/opus/sonnet/haiku) that don't match the
// configured ids (e.g. "ppio/pa/claude-opus-4-8"), AND it reports
// supportsEffort:true for EVERY model including non-Claude ones — so it can
// neither be matched nor trusted. Effort is a Claude-family feature, so we
// classify by family keyword in the id, which is robust to provider prefixes.
//
// Level support per the official effort docs:
//   - xhigh : Opus 4.8 / 4.7 only
//   - max   : Opus 4.6+/4.7/4.8 and Sonnet 4.6
//   - low/medium/high : all effort-capable models
// → opus   = [low, medium, high, xhigh, max]
//   sonnet = [low, medium, high, max]        (no xhigh)
//   haiku / non-Claude = []                  (no effort support → hide chip)

import type { EffortLevel } from '@anthropic-ai/claude-agent-sdk'

const OPUS_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']
const SONNET_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'max']

/** Effort levels supported by `model`, as a three-state value mirroring
 *  Session.effortLevels:
 *    - undefined : no model set yet (capability unknown → UI fallback)
 *    - []        : model doesn't support effort → UI hides the chip
 *    - [levels]  : the supported subset → UI offers these
 *  Matching is case-insensitive substring on the id, so provider prefixes
 *  (`ppio/pa/claude-opus-4-8`, `anthropic/claude-sonnet-4-...`) still classify. */
export function effortLevelsForModel(model?: string): EffortLevel[] | undefined {
  if (!model) return undefined
  const id = model.toLowerCase()
  if (id.includes('opus')) return OPUS_LEVELS
  if (id.includes('sonnet')) return SONNET_LEVELS
  // haiku and every non-Claude model (deepseek, mimo, …) don't support effort.
  return []
}

/** Whether `model` supports extended thinking at all. Same keyword-family
 *  classification and the same gateway rationale as effortLevelsForModel:
 *  the SDK's supportedModels() report (ModelInfo.supportsAdaptiveThinking /
 *  supportsThinking) is unreliable on gateway/proxy deployments, but the
 *  model-id prefix still says which family we're talking to.
 *
 *  Three-state, mirroring Session.thinkingSupported:
 *    - undefined : no model set yet (capability unknown → UI shows the chip)
 *    - false     : model can't think → UI hides the chip
 *    - true      : model can think
 *
 *  Haiku: Haiku 4.5 does support thinking, but the plain `claude-haiku-*`
 *  ids in this app's model list are the non-thinking variants — and any
 *  gateway alias we can't classify should fail soft (hide), consistent
 *  with effort's haiku/no-match → [] rule. */
export function supportsThinkingForModel(model?: string): boolean | undefined {
  if (!model) return undefined
  const id = model.toLowerCase()
  return id.includes('opus') || id.includes('sonnet')
}
