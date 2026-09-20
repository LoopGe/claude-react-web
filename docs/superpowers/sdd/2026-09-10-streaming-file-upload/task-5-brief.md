### Task 5: One size knob + pasted-image cap plumbing

**Files:**
- Modify: `server/config.ts` (defaults, new exported constant)
- Modify: `server/routes/config-routes.ts` (lightweight `/config` payload)
- Modify: `server/config.test.ts` (the 25 MB default assertion)
- Modify: `src/types/config.ts` (`ConfigResponse`)
- Modify: `src/hooks/config-store.ts` (accessor for the image cap)
- Modify: `src/App.tsx` (store the published image cap)
- Modify: `src/hooks/usePastedImages.ts` (use the image cap, not `maxUploadBytes`)
- Modify: `src/components/GlobalSettingsModal.tsx` (hint copy)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `MAX_PASTED_IMAGE_BYTES: number` exported from `server/config.ts`
  - `/api/config` payload gains `maxPastedImageBytes: number`
  - `getMaxPastedImageBytes(): number` / `setMaxPastedImageBytes(v: number): void` in `src/hooks/config-store.ts`

- [ ] **Step 1: Write the failing tests**

In `server/config.test.ts`, change the default assertion at line ~20:

```ts
    expect(config.maxUploadBytes).toBe(500 * 1024 * 1024)
```

Create `src/hooks/usePastedImages.test.ts` (it does not exist yet):

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { usePastedImages } from './usePastedImages'
import { setMaxUploadBytes, setMaxPastedImageBytes } from './config-store'

describe('usePastedImages cap', () => {
  beforeEach(() => {
    setMaxUploadBytes(500 * 1024 * 1024)
    setMaxPastedImageBytes(25 * 1024 * 1024)
  })

  it('caps the pasted-image total by the pasted-image cap, not the upload cap', async () => {
    setMaxPastedImageBytes(5) // 5 bytes
    const { result } = renderHook(() => usePastedImages())
    await act(async () => {
      await result.current.addImage(new File([new Uint8Array(10)], 'a.png', { type: 'image/png' }))
    })
    expect(result.current.error).toMatch(/too large/i)
    expect(result.current.images).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run server/config.test.ts src/hooks/usePastedImages.test.ts`
Expected: FAIL — `setMaxPastedImageBytes` is not exported; the default is still 25 MB.

- [ ] **Step 3: Server config**

In `server/config.ts`, change the default:

```ts
  maxUploadBytes: 500 * 1024 * 1024,
```

Add the exported constant next to `DEFAULTS`:

```ts
/** Hard cap on the total size of pasted images in one message. NOT a user
 *  setting: those bytes ride the buffered JSON message body (base64, ×~1.33),
 *  so this is a memory-safety limit, not a preference. The user-facing file
 *  upload knob is `maxUploadBytes`. */
export const MAX_PASTED_IMAGE_BYTES = 25 * 1024 * 1024
```

- [ ] **Step 4: Publish it in `/api/config`**

In `server/routes/config-routes.ts`, add to the lightweight `/config` payload (beside `maxUploadBytes`):

```ts
      maxPastedImageBytes: MAX_PASTED_IMAGE_BYTES,
```

and add the constant to the file's existing config import (line ~13), which currently reads
`import { config as serverConfig, loadConfig, readConfigFile, updateConfigFile } from '../config.js'`:

```ts
import { config as serverConfig, loadConfig, readConfigFile, updateConfigFile, MAX_PASTED_IMAGE_BYTES } from '../config.js'
```

- [ ] **Step 5: Client store + types + App**

`src/hooks/config-store.ts` — add beside the existing pair:

```ts
let _maxPastedImageBytes = 25 * 1024 * 1024

export function getMaxPastedImageBytes(): number {
  return _maxPastedImageBytes
}

export function setMaxPastedImageBytes(v: number): void {
  if (v > 0) _maxPastedImageBytes = v
}
```

`src/types/config.ts` — add to `ConfigResponse`:

```ts
  maxPastedImageBytes?: number
```

`src/App.tsx` — import `setMaxPastedImageBytes` and call it beside the existing line:

```ts
        if (r.maxUploadBytes != null) setMaxUploadBytes(r.maxUploadBytes)
        if (r.maxPastedImageBytes != null) setMaxPastedImageBytes(r.maxPastedImageBytes)
```

`src/hooks/usePastedImages.ts` — change the import and the read:

```ts
import { getMaxPastedImageBytes } from './config-store'
```
```ts
    const maxTotal = getMaxPastedImageBytes()
```

- [ ] **Step 6: UI copy**

In `src/components/GlobalSettingsModal.tsx`, change the "Max upload size" hint:

```ts
          hint="Largest uploaded file accepted (backgrounds, session files). Pasted images are capped separately. 0 = no override (server default 500 MB)."
```

- [ ] **Step 7: Run the tests and typecheck**

Run: `npx vitest run server/config.test.ts src/hooks/usePastedImages.test.ts && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 8: Commit**

```bash
git add server/config.ts server/routes/config-routes.ts server/config.test.ts src/types/config.ts src/hooks/config-store.ts src/App.tsx src/hooks/usePastedImages.ts src/hooks/usePastedImages.test.ts src/components/GlobalSettingsModal.tsx
git commit -m "feat(config): one upload-size knob; pasted images keep an internal cap"
```

---

