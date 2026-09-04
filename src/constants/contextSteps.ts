/** Client re-export of the shared 1M-context beta constant. The canonical
 *  value lives in `shared/context-steps.ts` so the server can import it too
 *  (the spawn-time default); keep this file so existing client imports of
 *  `constants/contextSteps` keep working. */
export { ONE_M_CONTEXT_BETA } from '../../shared/context-steps'
