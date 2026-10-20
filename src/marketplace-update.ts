// Shared bits of the marketplace "check for updates" client, used by BOTH
// marketplace panels (MarketplaceTab + AppPluginMarketplaceSection).

/** Client-side budget for `POST …/check-updates`, in ms.
 *
 *  The server runs one `git ls-remote` per marketplace via Promise.allSettled,
 *  so the batch's worst case is the SLOWEST single call, not their sum. But
 *  `gitLsRemoteHead` is not one call: it asks for `HEAD`, and when the remote
 *  doesn't advertise one (some don't) it retries with a bare `ls-remote` — two
 *  sequential calls, each capped at PULL_TIMEOUT_MS (60s) in
 *  server/git-clone.ts. So the true ceiling is ~120s, and the transport's 30s
 *  default would abort a batch the server was about to answer successfully,
 *  blanking every badge. Stay above 2×PULL_TIMEOUT_MS. */
export const CHECK_UPDATES_TIMEOUT_MS = 150_000

/** Client-side budget for `POST …/refresh` (the row Update), in ms.
 *
 *  The route is not just a pull: it runs `git pull --ff-only` (capped at
 *  PULL_TIMEOUT_MS = 60s), then re-parses the catalog and revalidates every
 *  installed plugin (hashing each plugin directory) before responding. The
 *  transport's 30s default aborts inside that window, which would report a
 *  failure for a pull the server went on to complete — leaving the badge
 *  uncleared even though the checkout did move. Stay well above
 *  PULL_TIMEOUT_MS. */
export const MARKETPLACE_PULL_TIMEOUT_MS = 180_000