/** Reserved POST /profiles template keywords, shared by the server (keyword
 *  resolution in the create route + the load-time collision warning in
 *  profiles.ts) and the client (ProfileCreateDialog's disabled radio), so the
 *  keyword set cannot drift between the sides that must agree on it.
 *
 *  A profile whose id equals one of these can never be selected as a template
 *  by that id — the keyword wins — which is only reachable via a hand-edited
 *  config.json (generated ids are 'default' / 'p_*'). */

/** Copy the built-in DEFAULT profile (official API + stock model list). */
export const PROFILE_TEMPLATE_BLANK = 'blank'

/** Copy the currently active profile (the historic create behavior). */
export const PROFILE_TEMPLATE_ACTIVE = 'active'

export const RESERVED_PROFILE_TEMPLATE_IDS: readonly string[] = [
  PROFILE_TEMPLATE_BLANK,
  PROFILE_TEMPLATE_ACTIVE,
]

export function isReservedProfileTemplateId(id: string): boolean {
  return RESERVED_PROFILE_TEMPLATE_IDS.includes(id)
}
