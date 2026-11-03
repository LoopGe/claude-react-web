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

The `panel-reshow` specs use the same production `MessageList` and real
Virtuoso to attach frame-by-frame re-show telemetry. They cover the 320ms panel
CSS animation and transparent hold, row-animation creation inside the 500ms
sweep deadline, and the 750ms mechanical follow-rearm suppression. A separate
deterministic wrapper-replacement case proves that message-id dedup survives
element churn. The panel class is applied by the fixture host, so these specs
validate the production CSS and MessageList/scroll contracts, not App's
`openIds` classification or its own scroll-memory re-assert loop.

The separate `app-panel-reshow` config drives the real App through its Hono
REST/WS server and real Virtuoso. Four dormant UUID sessions and an A/B group
are seeded with the production `SessionStore`, `TranscriptSidecar` and
`UiStateStore`; only the provider process boundary is replaced by an
init-yielding fake handle, so no model subprocess is involved. It covers cached
AWAY restoration, native-wheel/keyboard/per-panel cancellation of App
re-assert, non-scroll input controls, Alt+Arrow seek takeover, reduced-motion
epochs, and visible panel reorder without a keep-alive re-show. The default
Playwright config ignores this spec because it needs the app-specific API/Vite
ports.

```bash
npm run test:browser:app
```
