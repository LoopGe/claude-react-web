import type { RefObject } from 'react'
import { IconSearch, IconX } from './icons/ToolIcons'

interface SearchFieldProps {
  value: string
  onChange: (value: string) => void
  placeholder: string
  ariaLabel: string
  /** Wrapper class from the caller: the visual chrome (inset menu header,
   *  bordered toolbar, panel row) stays with the surface that owns it. */
  wrapperClassName: string
  /** Only needed where the CSS styles the input by class (e.g. the model
   *  picker's monospace input); element-selector surfaces omit it. */
  inputClassName?: string
  /** Required so clearing can return focus to the input instead of dropping
   *  it on the removed clear button. */
  inputRef: RefObject<HTMLInputElement | null>
  iconSize?: number
  showClear?: boolean
  disabled?: boolean
  ariaControls?: string
  ariaActiveDescendant?: string
  ariaAutocomplete?: 'none' | 'list' | 'both' | 'inline'
}

/**
 * Icon + input + optional clear button for the field/project/model pickers and
 * the session search panel. Each caller passes its own wrapper class so the
 * surface keeps its chrome. Keyboard/listbox wiring stays with the caller
 * (`handleKeyDown`, `aria-*`), because those lists own different activation
 * semantics; the handler lives on the containing menu/panel, so events bubble
 * from this input without extra wiring.
 */
export function SearchField({
  value,
  onChange,
  placeholder,
  ariaLabel,
  wrapperClassName,
  inputClassName,
  inputRef,
  iconSize = 13,
  showClear = true,
  disabled = false,
  ariaControls,
  ariaActiveDescendant,
  ariaAutocomplete,
}: SearchFieldProps) {
  return (
    <div className={wrapperClassName}>
      <IconSearch size={iconSize} aria-hidden />
      <input
        ref={inputRef}
        className={inputClassName}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        aria-controls={ariaControls}
        aria-activedescendant={ariaActiveDescendant}
        aria-autocomplete={ariaAutocomplete}
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
      />
      {showClear && value !== '' && (
        <button
          type="button"
          className="search-field-clear"
          aria-label="Clear search"
          disabled={disabled}
          onClick={() => {
            onChange('')
            inputRef.current?.focus()
          }}
        >
          <IconX size={12} />
        </button>
      )}
    </div>
  )
}