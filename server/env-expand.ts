// One expansion contract for environment references in host paths: `${VAR}`
// launch templates (open-path) and `%VAR%` registry values (app-paths). An
// unset reference makes the whole value unusable (null) — never a partially
// defaulted path that would launch or probe the wrong location.

/** Expand every match of `reference` (capture group 1 = variable name)
 *  against `env`; null when any referenced variable is unset. */
export function expandEnvReferences(value: string, env: NodeJS.ProcessEnv, reference: RegExp): string | null {
  let unset = false
  const expanded = value.replace(reference, (_m, name: string) => {
    if (env[name] === undefined) unset = true
    return env[name] ?? ''
  })
  return unset ? null : expanded
}