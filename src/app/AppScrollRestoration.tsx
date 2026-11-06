import { useAppScrollRestoration, type AppScrollRestorationProps } from './useAppScrollRestoration'

/** Focused composition used by App-level integration tests. */
export function AppScrollRestoration(props: AppScrollRestorationProps): null {
  useAppScrollRestoration(props)
  return null
}
