import { memo } from 'react'

interface PromptSuggestionsProps {
  suggestion: string | null
  onSelect: (text: string) => void
}

/** Renders the SDK-predicted next-user-prompt as a clickable chip above the
 *  composer. Shown after each turn when `promptSuggestions` is enabled;
 *  cleared automatically when the user sends a new message. */
export const PromptSuggestions = memo(function PromptSuggestions({
  suggestion,
  onSelect,
}: PromptSuggestionsProps) {
  if (!suggestion) return null

  return (
    <div className="prompt-suggestions">
      <button
        type="button"
        className="prompt-suggestion-chip"
        onClick={() => onSelect(suggestion)}
        title={suggestion}
      >
        {suggestion}
      </button>
    </div>
  )
})
