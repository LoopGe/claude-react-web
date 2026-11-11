// Brand-color icons for the "Open in …" targets — one component per app in
// the open-path closed set. These differ from ToolIcons' stroke glyphs in
// fill semantics: each paints its OFFICIAL brand color, carried by a
// `--brand-<id>` CSS variable defined in BOTH theme blocks of
// src/styles/tokens.css (never hardcode the hex here — the stylesheet owns
// the values and their dark/light adaptation).
//
// Glyph data is Simple Icons path data (CC0); the slugs are pinned in the
// per-icon comment so an icon can be re-fetched or re-sourced (e.g. official
// brand assets) without re-deriving it. Microsoft marks (vscode,
// windowsterminal) were REMOVED from current simple-icons releases at
// Microsoft's trademark request — those two paths come from the last release
// that carried them (v6.8.0).
import type { ComponentType } from 'react'

interface BrandIconProps {
  size?: number
}

/** Build one brand icon component from vetted path data. Private factory:
 *  the public surface is the named components and the BRAND_ICONS map. */
function brandIcon(id: string, d: string): ComponentType<BrandIconProps> {
  function Icon({ size = 14 }: BrandIconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        aria-hidden
        focusable="false"
      >
        <path fill={`var(--brand-${id})`} d={d} />
      </svg>
    )
  }
  return Icon
}

/** Visual Studio Code — simple-icons slug `visualstudiocode` (v6.8.0; removed
 *  upstream at Microsoft's trademark request). Official hex #007ACC. */
export const IconVscode = brandIcon(
  'vscode',
  'M23.15 2.587L18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.261A1 1 0 0 0 .326 8.74L3.899 12 .326 15.26a1 1 0 0 0 .001 1.479L1.65 17.94a.999.999 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 20.06V3.939a1.5 1.5 0 0 0-.85-1.352zm-5.146 14.861L10.826 12l7.178-5.448v10.896z',
)

/** Cursor — simple-icons slug `cursor` (develop branch; post-v15 addition).
 *  Official hex #000000 (the tokens.css dark theme carries the white variant). */
export const IconCursor = brandIcon(
  'cursor',
  'M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23',
)

/** Zed — simple-icons slug `zedindustries` (v15.15.0; the editor logo lives
 *  under the company name). Official hex #084CCF. */
export const IconZed = brandIcon(
  'zed',
  'M2.25 1.5a.75.75 0 0 0-.75.75v16.5H0V2.25A2.25 2.25 0 0 1 2.25 0h20.095c1.002 0 1.504 1.212.795 1.92L10.764 14.298h3.486V12.75h1.5v1.922a1.125 1.125 0 0 1-1.125 1.125H9.264l-2.578 2.578h11.689V9h1.5v9.375a1.5 1.5 0 0 1-1.5 1.5H5.185L2.562 22.5H21.75a.75.75 0 0 0 .75-.75V5.25H24v16.5A2.25 2.25 0 0 1 21.75 24H1.655C.653 24 .151 22.788.86 22.08L13.19 9.75H9.75v1.5h-1.5V9.375A1.125 1.125 0 0 1 9.375 8.25h5.314l2.625-2.625H5.625V15h-1.5V5.625a1.5 1.5 0 0 1 1.5-1.5h13.19L21.438 1.5z',
)

/** iTerm2 — simple-icons slug `iterm2` (v15.15.0). Official hex #000000
 *  (the tokens.css dark theme carries the white variant). */
export const IconIterm2 = brandIcon(
  'iterm2',
  'M24 5.359v13.282A5.36 5.36 0 0 1 18.641 24H5.359A5.36 5.36 0 0 1 0 18.641V5.359A5.36 5.36 0 0 1 5.359 0h13.282A5.36 5.36 0 0 1 24 5.359m-.932-.233A4.196 4.196 0 0 0 18.874.932H5.126A4.196 4.196 0 0 0 .932 5.126v13.748a4.196 4.196 0 0 0 4.194 4.194h13.748a4.196 4.196 0 0 0 4.194-4.194zm-.816.233v13.282a3.613 3.613 0 0 1-3.611 3.611H5.359a3.613 3.613 0 0 1-3.611-3.611V5.359a3.613 3.613 0 0 1 3.611-3.611h13.282a3.613 3.613 0 0 1 3.611 3.611M8.854 4.194v6.495h.962V4.194zM5.483 9.493v1.085h.597V9.48q.283-.037.508-.133.373-.165.575-.448.208-.284.208-.649a.9.9 0 0 0-.171-.568 1.4 1.4 0 0 0-.426-.388 3 3 0 0 0-.544-.261 32 32 0 0 0-.545-.209 1.8 1.8 0 0 1-.426-.216q-.164-.12-.164-.284 0-.223.179-.351.18-.126.485-.127.344 0 .575.105.239.105.5.298l.433-.5a2.3 2.3 0 0 0-.605-.433 1.6 1.6 0 0 0-.582-.159v-.968h-.597v.978a2 2 0 0 0-.477.127 1.2 1.2 0 0 0-.545.411q-.194.268-.194.634 0 .335.164.56.164.224.418.38a4 4 0 0 0 .552.262q.291.104.545.209.261.104.425.238a.39.39 0 0 1 .165.321q0 .225-.187.359-.18.134-.537.134-.381 0-.717-.134a4.4 4.4 0 0 1-.649-.351l-.388.589q.209.173.477.306.276.135.575.217.191.046.373.064',
)

/** Windows Terminal — simple-icons slug `windowsterminal` (v6.8.0; removed
 *  upstream at Microsoft's trademark request). Official hex #4D4D4D (the
 *  tokens.css dark theme carries the light-gray variant). */
export const IconWindowsTerminal = brandIcon(
  'windowsterminal',
  'M8.165 6V3h7.665v3H8.165zm-.5-3H1c-.55 0-1 .45-1 1v2h7.665V3zM23 3h-6.67v3H24V4c0-.55-.45-1-1-1zM0 6.5h24V20c0 .55-.45 1-1 1H1c-.55 0-1-.45-1-1V6.5zM11.5 18c0 .3.2.5.5.5h8c.3 0 .5-.2.5-.5v-1.5c0-.3-.2-.5-.5-.5h-8c-.3 0-.5.2-.5.5V18zm-5.2-4.55l-3.1 3.1c-.25.25-.25.6 0 .8l.9.9c.25.25.6.25.8 0l4.4-4.4a.52.52 0 0 0 0-.8l-4.4-4.4c-.2-.2-.6-.2-.8 0l-.9.9c-.25.2-.25.55 0 .8l3.1 3.1z',
)

/** Open-path target id → its brand icon. The keys mirror the editor/terminal
 *  ids the open-path target set uses (Finder and the generic file-manager /
 *  terminal entries are NOT here — they are semantic actions rendered by the
 *  existing ToolIcons folder/terminal glyphs, not brand marks). */
export const BRAND_ICONS: Record<string, ComponentType<BrandIconProps>> = {
  vscode: IconVscode,
  cursor: IconCursor,
  zed: IconZed,
  iterm2: IconIterm2,
  windowsterminal: IconWindowsTerminal,
}
