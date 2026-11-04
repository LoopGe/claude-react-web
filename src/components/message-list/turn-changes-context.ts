import { createContext, useContext } from 'react'

/** Opens the per-turn change review panel on one listed file. */
export interface TurnChangesContextValue {
  openTurnReview: (resultUuid: string, index: number) => void
}

/** The default is a no-op so a transcript rendered outside Chat (tests,
 *  overlays) still renders the card; only the click affordance is inert. */
export const TurnChangesCtx = createContext<TurnChangesContextValue>({
  openTurnReview: () => {},
})

export const TurnChangesProvider = TurnChangesCtx.Provider

export function useTurnChangesContext(): TurnChangesContextValue {
  return useContext(TurnChangesCtx)
}