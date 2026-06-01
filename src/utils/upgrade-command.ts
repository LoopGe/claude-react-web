// Builds the shell command shown in the update banner and the About tab.
//
// Two things make a hardcoded `npx claude-react-web@latest` wrong:
//   1. The package is scoped (`@mi/claude-react-web`) — dropping the scope
//      installs a different package.
//   2. It lives on a private registry — without `--registry=<…>` the
//      command hits the public registry and 404s.
//
// Both values come from the server's UpdateInfo (packageName + the
// configured updateCheckRegistry it actually probed), so the command we
// render matches how the user installed in the first place.

/**
 * @param packageName canonical npm name, e.g. `@mi/claude-react-web`
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
