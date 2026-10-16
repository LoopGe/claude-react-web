// The non-core highlight.js grammars load on demand (lowlight-instance.ts,
// markdown-features.ts). Pinned here:
//   * a render made before its grammar loaded is shown but never cached, and
//     the mounted <Markdown> / <DiffLine> re-render to the final output once
//     the load lands;
//   * after the loads, every render is byte-identical to the old eager
//     pipeline (src/test-utils/markdown-reference.ts), search marks included;
//   * the math facts are untouched (KaTeX stays eager): `\[…\]` is still not
//     math, the baseline sample still renders 3 KaTeX nodes.
//
// Order matters: the first tests need swift/go/rust NOT loaded yet. Each of
// them asserts the pre-load state synchronously, before its first await, so a
// load started by an earlier test can't have landed in between.

import { describe, it, expect, afterEach } from 'vitest'
import type { ReactNode } from 'react'
import { render, waitFor } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Markdown } from '../components/Markdown'
import { DiffLine } from '../components/tool-views/diff-shared'
import { clearMarkdownCache, compileMarkdown, markdownCacheSize, type CompileMarkdownOptions } from './markdown-cache'
import { LAZY_GRAMMARS, lowlight, requestGrammar, type LazyGrammar } from './lowlight-instance'
import { highlightLineHast } from './diff-highlight'
import { referenceCompile } from '../test-utils/markdown-reference'

afterEach(() => clearMarkdownCache())

const html = (node: ReactNode) => renderToStaticMarkup(<>{node}</>)

/** The baseline session's turn-1 sample: every registered language, haskell
 *  and mermaid (unregistered), inline + display math and `\[…\]`. */
const BASELINE_SAMPLE = [
  '## Math',
  'Inline math: the identity $e^{i\\pi} + 1 = 0$ and the sum $\\sum_{k=1}^{n} k = \\frac{n(n+1)}{2}$ sit inside a sentence.',
  'Block math with dollars:',
  '$$',
  '\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}',
  '$$',
  'Block math with brackets:',
  '\\[',
  '\\mathbf{A} = \\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}, \\quad \\det \\mathbf{A} = ad - bc',
  '\\]',
  '## Code',
  '```ts', 'interface User { id: number; name: string }', 'export const greet = (u: User): string => `hi ${u.name}`', '```',
  '```python', 'def fib(n: int) -> int:', '    return n if n < 2 else fib(n - 1) + fib(n - 2)', '```',
  '```bash', 'for f in *.log; do echo "$f"; done | sort -u', '```',
  '```json', '{ "name": "demo", "version": "1.0.0", "private": true }', '```',
  '```rust', 'fn main() { let v: Vec<i32> = (1..=3).collect(); println!("{:?}", v); }', '```',
  '```go', 'func Add(a, b int) int { return a + b }', '```',
  '```yaml', 'services:', '  web:', '    image: nginx:1.27', '    ports: ["8080:80"]', '```',
  '```diff', '- const old = 1', '+ const next = 2', '```',
  '```sql', 'SELECT id, name FROM users WHERE active = 1 ORDER BY name;', '```',
  '```java', 'public class Hi { public static void main(String[] a) { System.out.println("hi"); } }', '```',
  '```cpp', '#include <vector>', 'int main() { std::vector<int> v{1,2,3}; return v.size(); }', '```',
  '```css', '.card { color: var(--fg); border-radius: 8px; }', '```',
  '```html', '<div class="card"><a href="/x">link</a></div>', '```',
  '```ruby', 'puts [1, 2, 3].map { |x| x * 2 }.inspect', '```',
  '```swift', 'let xs = [1, 2, 3].map { $0 * 2 }', '```',
  '```kotlin', 'fun main() { println(listOf(1, 2, 3).map { it * 2 }) }', '```',
  '```csharp', 'var xs = new[] { 1, 2, 3 }.Select(x => x * 2);', '```',
  '```php', '<?php echo array_sum([1, 2, 3]); ?>', '```',
  '```dockerfile', 'FROM node:20-alpine', 'RUN npm ci --omit=dev', '```',
  '```makefile', 'build:', '\tgo build ./...', '```',
  '```toml', '[package]', 'name = "demo"', '```',
  '```properties', 'server.port=8080', '```',
  '```markdown', '# Title', '- item', '```',
  '```haskell', 'main :: IO ()', 'main = print (sum [1..10])', '```',
  '```mermaid', 'graph TD', '  A[Start] --> B{Ok?}', '  B -->|yes| C[Done]', '```',
].join('\n')

describe('lazy markdown features: before the loads', () => {
  it('renders the fence plain, keeps that tree out of the cache, then the mounted block re-renders highlighted', async () => {
    expect(lowlight.registered('rust')).toBe(false)
    const md = 'before $x^2$\n\n```rust\nfn main() { let v: Vec<i32> = (1..=3).collect(); }\n```'
    const sizeBefore = markdownCacheSize()
    // Compile directly: the pre-load tree is NOT admitted…
    const pre = html(compileMarkdown(md, {}))
    expect(pre).not.toContain('hljs-')
    expect(pre).toContain('katex') // math is eager and unaffected
    expect(markdownCacheSize()).toBe(sizeBefore)
    // …the mounted component shows the same pre-load output first…
    const { container } = render(<Markdown text={md} />)
    expect(container.querySelector('[class*="hljs-"]')).toBeNull()
    // …and the SAME mount re-renders once the grammar lands (no remount, no
    // prop change: the feature-version subscription is what drives it).
    await waitFor(() => expect(container.querySelector('[class*="hljs-"]')).not.toBeNull())
    // The final tree is cached now, and is what a fresh compile returns.
    expect(markdownCacheSize()).toBe(sizeBefore + 1)
    expect(html(compileMarkdown(md, {}))).toBe(html(referenceCompile(md)))
  })

  it('search variant: a pre-load render is not cached either, and re-renders final', async () => {
    expect(lowlight.registered('swift')).toBe(false)
    const md = '```swift\nlet xs = [1, 2, 3].map { $0 * 2 }\n```\n\nmap it'
    const opts: CompileMarkdownOptions = { searchQuery: 'map', activeMatchIdx: 0 }
    const sizeBefore = markdownCacheSize()
    expect(html(compileMarkdown(md, opts))).not.toContain('hljs-')
    expect(markdownCacheSize()).toBe(sizeBefore)
    const { container } = render(<Markdown text={md} searchQuery="map" activeMatchIdx={0} />)
    expect(container.querySelector('[class*="hljs-"]')).toBeNull()
    expect(container.querySelectorAll('mark.search-hl').length).toBeGreaterThan(0)
    await waitFor(() => expect(container.querySelector('[class*="hljs-"]')).not.toBeNull())
    expect(html(compileMarkdown(md, opts))).toBe(html(referenceCompile(md, opts)))
  })

  it('a lazily loaded language highlights once it loads (fence, then a diff line)', async () => {
    expect(lowlight.registered('go')).toBe(false)
    const md = '```go\nfunc Add(a, b int) int { return a + b }\n```'
    const { container } = render(<Markdown text={md} />)
    expect(container.querySelector('code')?.textContent).toContain('func Add')
    expect(container.querySelector('[class*="hljs-"]')).toBeNull()
    // The diff path, same grammar, before it lands: plain, and not cached.
    const line = 'func Add(a, b int) int { return a + b }'
    expect(highlightLineHast('go', line)).toBeNull()
    const diff = render(<DiffLine line={line} marker="+" variant="add" language="go" />)
    expect(diff.container.querySelector('[class*="hljs-"]')).toBeNull()
    await waitFor(() => expect(container.querySelector('[class*="hljs-"]')).not.toBeNull())
    await waitFor(() => expect(diff.container.querySelector('[class*="hljs-"]')).not.toBeNull())
    expect(highlightLineHast('go', line)).not.toBeNull()
    expect(html(compileMarkdown(md, {}))).toBe(html(referenceCompile(md)))
  })
})

describe('lazy markdown features: after the loads, identical to the eager pipeline', () => {
  const loadAll = async () => {
    await Promise.all((Object.keys(LAZY_GRAMMARS) as LazyGrammar[]).map((id) => requestGrammar(id)))
  }

  const FIXTURES: Record<string, string> = {
    baselineSample: BASELINE_SAMPLE,
    bracketMath: '\\[\nx^2\n\\]\n\nand \\(y\\) inline',
    mathFence: '```math\n\\frac{a}{b}\n```',
    dollarsInCode: 'use `$env:NAME` here\n\n```bash\necho "$HOME" ${PATH}\n```',
    pairedPrices: 'costs $5 and $10 total',
    aliasesAndCase: '```Kotlin\nval x = 1\n```\n```YML\na: 1\n```\n```c\nint x;\n```\n```protobuf\nmessage A {}\n```\n```mjs\nexport {}\n```',
    jsxAndTemplates: '```tsx\nconst v = <Box sx={{ p: 1 }} />\nconst s = css`color: red;`\n```',
    erbYaml: '```yaml\nimage: <%= image %>\n```',
    unknownAndEmpty: '```elixir\nIO.puts 1\n```\n```go\n```\n```\nplain\n```',
    mathInTable: '| a | b |\n|---|---|\n| $x$ | `y` |',
    mathInListAndQuote: '- $a$\n- b\n\n> $$\n> c\n> $$',
    rawHtml: '<div class="math-inline">$x$</div>',
  }

  it('renders every fixture exactly as before (plain and breaks variants)', async () => {
    await loadAll()
    for (const [name, md] of Object.entries(FIXTURES)) {
      for (const breaks of [false, true]) {
        expect(html(compileMarkdown(md, { breaks })), `${name} breaks=${breaks}`).toBe(html(referenceCompile(md, { breaks })))
      }
    }
  })

  // Every search variant compiles a throwaway processor (no cache across
  // variants), so this is the slow one: kept to a few queries, own timeout.
  it('search marks and the copied/selected text are identical too', { timeout: 30_000 }, async () => {
    await loadAll()
    const queries = ['x', 'map', '$']
    for (const [name, md] of Object.entries(FIXTURES)) {
      for (const searchQuery of queries) {
        for (const activeMatchIdx of [undefined, 1]) {
          const opts = { searchQuery, activeMatchIdx }
          expect(html(compileMarkdown(md, opts)), `${name} q=${searchQuery} idx=${activeMatchIdx}`).toBe(html(referenceCompile(md, opts)))
        }
      }
      // textContent is what a copy of the selection and CodeBlock's Copy read.
      const now = render(<Markdown text={md} />)
      const ref = render(<div className="md">{referenceCompile(md)}</div>)
      expect(now.container.textContent, name).toBe(ref.container.textContent)
      now.unmount()
      ref.unmount()
    }
  })

  it('keeps `\\[…\\]` plain, and the baseline facts (3 KaTeX nodes, haskell/mermaid plain)', async () => {
    await loadAll()
    const { container } = render(<Markdown text={BASELINE_SAMPLE} />)
    expect(container.querySelectorAll('.katex').length).toBe(3)
    expect(container.querySelectorAll('.katex-display').length).toBe(1)
    const bracketPara = [...container.querySelectorAll('p')].find((p) => p.textContent?.includes('\\mathbf') || p.textContent?.includes('mathbf'))
    expect(bracketPara).toBeTruthy()
    expect(bracketPara!.querySelector('.katex')).toBeNull()
    for (const lang of ['haskell', 'mermaid']) {
      const code = container.querySelector(`code.language-${lang}`)
      expect(code, lang).not.toBeNull()
      expect(code!.querySelector('[class*="hljs-"]'), lang).toBeNull()
    }
  })
})
