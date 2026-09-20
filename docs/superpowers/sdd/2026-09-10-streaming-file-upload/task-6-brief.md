### Task 6: BackgroundPicker client-side pre-check

**Files:**
- Modify: `src/components/BackgroundPicker.tsx` (`handleUpload`)
- Modify: `src/components/BackgroundPicker.test.tsx`

**Interfaces:**
- Consumes: `getMaxUploadBytes()` from `src/hooks/config-store.ts`.
- Produces: no new interface.

- [ ] **Step 1: Write the failing test**

In `src/components/BackgroundPicker.test.tsx` the suite's `afterEach` must reset the shared module state the pre-check reads (module state survives `restoreAllMocks`). Change it to:

```tsx
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    setMaxUploadBytes(25 * 1024 * 1024) // config-store is module-global
  })
```

and add the import `import { setMaxUploadBytes } from '../hooks/config-store'`.

Append this case to the same describe block, matching the file's existing idioms (`fireEvent`, `vi.stubGlobal('fetch', …)`, `setting(...)`):

```tsx
  it('refuses an over-size file before sending any request', async () => {
    setMaxUploadBytes(10) // 10 bytes
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(<BackgroundPicker setting={setting({ kind: 'none' })} onChange={() => {}} />)
    fireEvent.click(screen.getByRole('radio', { name: 'Video' }))
    fireEvent.click(screen.getByText('Upload video…'))
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
    fireEvent.change(input, { target: { files: [new File([new Uint8Array(50)], 'big.mp4', { type: 'video/mp4' })] } })

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/too large/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run src/components/BackgroundPicker.test.tsx`
Expected: FAIL — no pre-check exists, so `fetch` is called.

- [ ] **Step 3: Add the pre-check**

In `src/components/BackgroundPicker.tsx`, at the top of `handleUpload`:

```ts
  const handleUpload = async (file: File) => {
    const forMedia = media
    const max = getMaxUploadBytes()
    if (file.size > max) {
      setApplied(false)
      setError(`File too large (${formatBytes(file.size)}). Max ${formatBytes(max)}.`)
      return
    }
    const form = new FormData()
    …
```

Add imports:

```ts
import { getMaxUploadBytes } from '../hooks/config-store'
import { formatBytes } from '../utils/format'
```

- [ ] **Step 4: Run the test file**

Run: `npx vitest run src/components/BackgroundPicker.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/BackgroundPicker.tsx src/components/BackgroundPicker.test.tsx
git commit -m "feat(background): refuse an over-size file client-side before uploading"
```

---

