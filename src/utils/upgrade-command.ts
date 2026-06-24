// Builds the shell command shown in the update banner and the About tab.
//
// Two things make a hardcoded `npx <name>@latest` wrong:
//   1. The published name may change (scope vs unscoped) — using the wrong
//      one installs a different package or 404s.
//   2. It may live on a private registry — without `--registry=<…>` the
//      command hits the public registry instead.
//
// Both values come from the server's UpdateInfo (packageName + the
// configured updateCheckRegistry it actually probed), so the command we
// render matches how the user installed in the first place.

/**
 * @param packageName canonical npm name, e.g. `claude-react-web`
 * @param registry    the probed registry URL; omitted/empty → no flag
 * @param global      true for the `npm i -g` form, false for `npx`
 */
export function buildUpgradeCommand(
  packageName: string,
  registry?: string,
  global = false,
): string {
  const base = global
    ? `npm i -g ${packageName}@latest`
    : `npx ${packageName}@latest`
  const reg = registry?.trim()
  return reg ? `${base} --registry=${reg}` : base
}

/** Build an install command for a SPECIFIC version (the version switcher and
 *  the recovery copy-command). Mirrors `buildUpgradeCommand` but pins
 *  `@<version>` instead of `@latest`. This is the exact command the user can
 *  paste into a terminal to roll back even when the app is bricked — so it
 *  must reflect the real package name + registry, never a hardcoded guess.
 *
 * @param packageName canonical npm name
 * @param version     the concrete version to pin (e.g. `0.5.8`)
 * @param registry    the probed registry URL; omitted/empty → no flag
 * @param global      true for the `npm i -g` form, false for `npx`
 */
export function buildInstallCommand(
  packageName: string,
  version: string,
  registry?: string,
  global = false,
): string {
  const base = global
    ? `npm i -g ${packageName}@${version}`
    : `npx ${packageName}@${version}`
  const reg = registry?.trim()
  return reg ? `${base} --registry=${reg}` : base
}
