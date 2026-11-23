/** Single-line preview of thinking text: whitespace collapsed, deliberately
 *  NO length cap — truncation is left to the CSS ellipsis on `.thinking-preview`,
 *  which always marks itself with "…" (the old `slice(0, 120)` cut the text
 *  with no ellipsis whenever the cap fit inside the panel width, so a clipped
 *  preview looked identical to a complete one). Shared by the settled and
 *  streaming renders so the fold hand-off is pixel-identical. Accepted costs
 *  of the uncapped preview — see the note on `.thinking-preview` in
 *  styles/chat.css: the preview line is a second full layout of the reasoning
 *  text, and the whole text sits in the <summary> (the toggle's accessible
 *  name, and what triple-click / select-all hands to copy and to the search
 *  seed). Lives in its own module (not beside the component) so the component
 *  file keeps its react-refresh component-only export shape. */
export function thinkingPreviewText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}
