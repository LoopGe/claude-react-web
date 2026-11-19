// Model-capability ladders live in shared/model-capability.ts (neutral,
// host-free); this module re-exports them so host consumers can keep
// importing from here.

export {
  effortLevelsForModel,
  supportsFastModeForModel,
  supportsThinkingForModel,
} from '../shared/model-capability.js'
