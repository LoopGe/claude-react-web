# Real-browser bottom-card regressions

These Playwright specs mount the production `MessageList`, `TodoChecklist`,
`MonitorBar`, `WorkingBubble` and a stable peer card in an isolated React root,
inside the real bottom-stack CSS and with the stable composer dock present. They
read the actual Virtuoso Footer spacer committed by `MessageList` on every
animation frame — the fixture never reimplements the reserve formula. No backend
session or model subprocess is involved.

```bash
npx playwright install chromium  # once per machine
npm run test:browser
```

The suite is intentionally separate from `npm test` because it needs a real
Chromium layout engine. It covers expanded and collapsed exits, the 45% capped
stack, and an aborted exit that re-enters on the same wrapper. The assertions
compare the actual spacer against the flow-derived reservation, allowing one
frame of pipeline lag and 1px of rounding. The static reservation must remain
after the target card unmounts. Each failure attaches the full frame series
(including scrollTop and last-message position telemetry) and a Playwright trace
under `test-results/`. Scroll-follow compensation is a separate contract; this
suite deliberately asserts spacer geometry, not a guessed message alignment
formula.
