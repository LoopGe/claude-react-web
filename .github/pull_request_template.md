<!-- Thanks for contributing! Keep the summary tight — a reviewer should know what changed and why before scrolling. -->

## What this changes

<!-- One or two sentences. What does the diff do? -->

## Why

<!-- The problem it solves. Link the issue if there is one: "Closes #123" -->

## How it was verified

<!--
Test output, screenshots, or a manual walkthrough. If you added tests, say so.
Paste the result of the command below — "tests pass" without output isn't verifiable.
-->

```bash
npm run verify
```

## Checklist

- [ ] `npm run verify` passes (typecheck + lint + test + build)
- [ ] Tests were added or updated for behaviour changes
- [ ] New colours use theme CSS variables, defined in **both** `:root` and `[data-theme="light"]`
- [ ] No `console.*` added for diagnostics — the server logs through `createLogger(scope)`
- [ ] If this touches the wire protocol, `shared/ws-protocol.ts` and any client-side rendering path were updated together
- [ ] Docs updated where behaviour changed: `README.md` and `README.zh-CN.md` kept in sync with each other, plus `docs/manual.en.md` / `docs/manual.zh-CN.md` and `CONFIG.md`
- [ ] The diff has been through a code review

## Notes for reviewers

<!-- Anything you're unsure about, alternatives you rejected, or parts worth extra scrutiny. -->
