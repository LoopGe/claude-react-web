import { useLocalStorage } from './useLocalStorage'
import { isTransparencyMode, TRANSPARENCY_KEY, type TransparencyMode } from '../utils/theme'

export function useTransparencyMode() {
  return useLocalStorage<TransparencyMode>(TRANSPARENCY_KEY, 'glass', {
    normalize: (value): TransparencyMode =>
      value === true ? 'glass' : value === false ? 'no-frost' : value as TransparencyMode,
    validate: isTransparencyMode,
  })
}
