# Agent Note: Open-path win32 detection reads the App Paths registry

Status: implemented

## Problem

The session context-menu "Open in" group omitted VS Code on a machine where it
was installed: `GET /open-path/apps` probed only the two default installer
paths (`%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe` and
`%ProgramFiles%\Microsoft VS Code\Code.exe`), and the install lived in a
custom directory (`D:\software\Microsoft VS Code`). A PATH fallback could not
close the gap structurally: the win32 `path` probe matches only `<name>.exe`,
while the VS Code / Kiro Windows CLI shim is `<name>.cmd`, and Node ≥ 20.12
refuses to `execFile` a `.cmd` without a shell. Kiro (added in the same change)
had the same custom-directory shape on the reporting machine.

## Decision

Catalog rows carry one `AppLocator` descriptor (`mac-app` / `file` / `path` /
`app-paths`) that serves BOTH the `/apps` availability probe and the launch
resolution — `openCommandsFor` is async and a row's launch file may come from
its probe result, so the menu still only offers what the POST would launch.
The `app-paths` locator (`server/app-paths.ts`) reads
`HKCU\…\App Paths\<exe>` then the HKLM twin through ONE PowerShell invocation
per exe (`-NoProfile -NonInteractive -Command` with a fixed script, never a
shell string, 10 s timeout, `windowsHide: true`, any failure means "no root
proves anything"). The script forces UTF-8 stdout and prints each root's RAW
default value as one line (empty when the key or value is absent,
`DoNotExpandEnvironmentNames` keeps `%VAR%` intact); the reader strips
surrounding quotes, expands `%VAR%` (unset variable → the value is unusable),
and verifies the result is an existing file, first proving root wins. The
resolved exe leads the launch chain; when the registry proves nothing its row
drops out and the fixed default paths carry the chain (behind a resolved exe
they remain only for the ENOENT race — the reader already verified existence).
App Paths is the canonical Windows "where does this exe live" mechanism —
installers write it regardless of install directory, and ShellExecute / Win+R
resolve through it.

PowerShell, not reg.exe, because a console child emits its console output
code page — measured gb2312 (CP936) on the reporting zh-CN host — so reg.exe
text mojibakes any non-ASCII install path under utf8 decoding and the locator
silently proves nothing. Forcing `[Console]::OutputEncoding` inside the fixed
script makes the output encoding deterministic regardless of the inherited
console (a dev terminal may have run `chcp 65001`). The shared expansion fold
for `${VAR}` templates and `%VAR%` registry values lives in
`server/env-expand.ts` (`expandEnvReferences`), one unset-reference contract
for both surfaces.

The win32 vscode and kiro rows use the chain (registry first, default paths
second); Kiro is a full brand target on all three platforms (`open -a Kiro`,
`kiro` on PATH, registry + `%LOCALAPPDATA%\Programs\Kiro\Kiro.exe`). The
strategy mirrors deepseek-harness's `packages/host/open-in-app` locator chain,
which proved the registry facts on the reporting machine for both editors.

`hostAppPathsRun` wraps the raw `execFile` callback contract `(err, stdout)`
in a promise instead of `util.promisify`: the promisified `{stdout, stderr}`
shape depends on execFile's custom promisify symbol, which a plain test mock
does not carry — the raw contract is what the route tests' mock faithfully
simulates. It sets `windowsHide: true`, the repo's uniform execFile discipline
(a console child must not flash a window on console-less hosts).

Directory launches spawn DETACHED (`stdio: 'ignore'`) and settle at
spawn-failure, an exit inside a 1.5 s early-failure watch window, or the
window closing with the child still running — never at the app's eventual
exit, and the child is never killed. The first shipped version waited for
exit under a 10 s execFile timeout, which TERMINATED first-instance editors:
on Windows a first-instance `Code.exe` IS the Electron main process and lives
as long as its window, so VS Code opened and was killed ~10 s later (server
metrics showed the POSTs at 10–30 s; the toast carried the child's startup
stderr). The watch-window model preserves the chain semantics the short-lived
launchers need (ENOENT fall-through, `open -a` nonzero-exit fall-through, the
explorer exit-1 quirk) while a long-lived launcher counts as launched at the
window — the same model as DSH's `launchDetachedApp`. The settle contract is
declared PER CANDIDATE (`exitsByContract` on the catalog row / OS-generic
launch row), by what the launcher IS — not by target name, because the same
argv appears under two targets with one contract (`wt -d` is both the win32
generic terminal and the windowsterminal brand row), and a target's rows can
mix contracts (the linux terminal chain). Exit-by-contract openers (`open`,
`open -a`, `explorer`, `xdg-open`, `gnome-terminal`, `konsole`) wait for exit
via `launchAndWait` under a 10 s timeout that kills a wedged opener (a
timeout kill is a failure outcome — on Windows TerminateProcess surfaces as
exit code 1, which must not be mistaken for the explorer exit-1 success
quirk). Everything that may live as long as its window — first-instance
editors, `wt` (a first-instance wt.exe IS the terminal window process),
`x-terminal-emulator` (the Debian alternative can be xterm, which never
exits), direct exe/CLI launchers — uses `launchDetached` with the 1.5 s
window ANCHORED AT THE SPAWN EVENT (a slow spawn must not run the window out
before the process exists); the browser case uses watch 0 (settle at the
`spawn` event itself). Both feed ONE outcome chain (ENOENT fall-through,
nonzero-exit fall-through, the explorer quirk). The detached child's error
listener is PERSISTENT: a long-lived child can emit more than one 'error',
and an unlistened 'error' event throws as an uncaught exception. Any error
before settle is a failure outcome (a post-spawn error inside the window
must not answer 200); an error after settle is logged, not swallowed
silently; a synchronous `spawn` / `execFile` throw (invalid argv) folds into
the same outcome shape so the candidate chain still sees it.

## Alternatives considered

**reg.exe with utf8 decoding (the DSH runner's choice).** Lost: measured on
the reporting host, a console child's output code page is gb2312, so reg.exe
emits GBK bytes and utf8 decoding corrupts every non-ASCII install path —
the exact custom-directory gap this change closes, on the locale the
localization work targets. DSH's reg.exe boundary carries the same latent
gap; its PowerShell boundaries force UTF-8 instead, which is the precedent
followed here.

**reg.exe with buffer output decoded by the discovered OEM code page.** Lost:
the OEMCP registry fact is not necessarily the child's actual console code
page — a dev terminal that ran `chcp 65001` is inherited by the child, so
OEMCP decoding would regress a configuration that decodes correctly today.
There is no deterministic way to read the child's console CP without native
code; forcing the output encoding inside the script removes the guess.

**Probe the PATH `.cmd` shim and derive the install root from it.** Lost: the
win32 `path` probe only matches `.exe`, so it would need a new extension
rule, and launching the shim needs a shell (forbidden) or a `bin\..\Code.exe`
derivation anyway. The registry proves the exe directly, covers installs that
never touched PATH, and is the mechanism Windows itself uses.

**Scan the Uninstall registry records (DSH's second locator).** Deferred, not
rejected on merit: App Paths alone proved every standard-installer install on
the reporting machine, while the Uninstall scan dumps three whole roots
(`reg.exe query /s`) and matches DisplayName prefixes. It can land later as
another locator kind without touching the model.

**A DSH-style cached resolution pass (resolve the catalog once, launch from
the map, re-resolve on ENOENT).** Lost: a larger route restructure than the
gap requires. Targeted `/ve` queries are milliseconds, run per request, and
keep the existing row model where one descriptor serves probe and launch.

**Per-brand special-case branches for custom directories.** Lost: the repo
convention is a single locator vocabulary, not accumulated conditionals.

## Consequences

Custom-directory installs are detected and launched with the verified exe,
including non-ASCII install directories; the probe/launch single-source
invariant holds. Cost: one PowerShell spawn per registry-backed target per
`/apps` or POST request on win32 (hundreds of milliseconds cold, bounded at
10 s; the registry row is tried first so it short-circuits the fixed paths
when it hits). A genuine early launch failure surfaces as an exit code, not
the child's stderr: stdio is ignored on purpose, because holding a stderr
pipe past the watch window would either block a chatty long-lived child when
the buffer fills or EPIPE it when the pipe is destroyed — the diagnostic
cost is knowingly accepted (DSH makes the same choice). `/apps` probes
targets concurrently, so the registry-backed
brands overlap their cold starts and the endpoint costs roughly one query,
not one per brand; a POST launch still pays one fresh query (the launch-time
fact is deliberately not memoized). Cursor and Zed keep their
fixed-path/PATH-only rows until they adopt the locator. The client's
per-page-load `/apps` memo is unchanged: a mid-session install still needs a
browser reload.

The Kiro glyph is the official product asset (the `kiricons` `kiro.svg`,
identical to the kiro.dev favicon mark) — simple-icons carries no Kiro entry.
Its native 17×16 box is scaled into the shared 24×24 viewBox with an SVG
`transform` on the path (the factory's optional third argument), keeping the
uniform viewBox contract the icon tests pin. The brand color `#9046FF` comes
from the kiro.dev favicon ground and is safe on both themes, so both theme
blocks carry the official hex.

## Testing

`server/app-paths.test.ts` pins the per-root line contract and the chain over
injected process facts (HKCU preference, stale-value fall-through, quote
stripping, `%VAR%` expansion, unset-variable null, non-ASCII path intact),
plus the query argv: PowerShell, forced UTF-8, both roots in order, raw
values. `server/env-expand.test.ts` pins the shared expansion fold for both
reference syntaxes. `server/routes/open-path.test.ts` pins registry-only
detection, the launch-chain order, route-level query fixtures verified
against the real fs (the stub answers only the query naming the given exe, so
one app's registry fact can never prove another), and Kiro on all three
platforms, and the launch model: a still-running launcher counts as launched
and is never killed, early nonzero exits still fall through per row semantics.
Client pins: `BrandIcons.test.tsx` key set,
`tokens.brand-vars.test.ts` theme pairing and official light hex,
`SessionContextMenu.test.tsx` flyout label list. Real-machine verification on
the reporting host: `availableAppsFor` → `['vscode', 'kiro']`, launch chains →
the `D:\software\…` executables, and a forced-UTF-8 `D:\软件\Kiro` roundtrip
through the real boundary intact.