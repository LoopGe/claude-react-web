// @claude-react-web/plugin-api — SDK for authoring App Plugins.
//
// Plugin authors write a background service using `definePlugin`:
//
//   import { definePlugin } from '@claude-react-web/plugin-api'
//
//   export default definePlugin({
//     async activate(ctx) { /* ctx.configuration, ctx.dataDir */ },
//     async executeCommand({ invocationId, commandId, context, host }) {
//       const text = context.selection?.text ?? ''
//       const res = await host.ai.request({ purpose: 'translate', system: '...', messages: [{ role: 'user', content: text }] })
//       return { type: 'popover', invocationId, content: { kind: 'markdown', markdown: res.content } }
//     },
//   })
//
// Bundle with esbuild/rollup into dist/service.mjs (the SDK is a build-time
// dep — the published plugin dist is self-contained, the host runs `node
// dist/service.mjs` directly with no npm install).

export { definePlugin, createStdioTransport, HostError, type Transport, type PluginHandlers } from './runtime.js'
export { createHost, type CallHost } from './host.js'
export type {
  Host, PluginCommandContext, PluginCommandResult, PluginResultContent,
  ActivateContext, DeactivateReason, ExecuteCommandRequest,
  PluginManifest, AppPluginPermission, PermissionSpec, PermissionParams,
  StorageScope, NetworkFetchOptions, NetworkFetchResult,
  AiRequestOptions, AiRequestResult, SessionMetadata, GitReadOptions,
} from './types.js'
