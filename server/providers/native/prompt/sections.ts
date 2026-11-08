// server/providers/native/prompt/sections.ts
/** DSH-style ordered system-prompt section registry. Tools register their
 *  own guidance sections; the renderer concatenates by `order`. Sections are
 *  stable per conversation — the registry is rebuilt per session, not per
 *  turn, in P1 (hot-plug comes with tool lifecycle in P3). */
export interface PromptSection {
  name: string
  order: number
  text: string
}

export class PromptSectionRegistry {
  private sections = new Map<string, PromptSection>()

  register(section: PromptSection): void {
    if (this.sections.has(section.name)) {
      throw new Error(`duplicate prompt section: ${section.name}`)
    }
    this.sections.set(section.name, section)
  }

  has(name: string): boolean {
    return this.sections.has(name)
  }

  render(): string {
    return [...this.sections.values()]
      .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
      .map((s) => s.text)
      .join('\n\n')
  }
}

export const IDENTITY_SECTION: PromptSection = {
  name: 'harness:identity',
  order: 0,
  text: 'You are an AI agent powered by claude-react-web.',
}
