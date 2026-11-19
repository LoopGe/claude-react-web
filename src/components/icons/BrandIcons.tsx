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
 *  the public surface is the named components and the BRAND_ICONS map.
 *  `transform` scales/centers an asset whose native viewBox is not 24×24
 *  into the shared box (the SVG-native way — no coordinate rewriting). */
function brandIcon(id: string, d: string, transform?: string): ComponentType<BrandIconProps> {
  function Icon({ size = 14 }: BrandIconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        aria-hidden
        focusable="false"
      >
        <path fill={`var(--brand-${id})`} d={d} transform={transform} />
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

/** Kiro — official product asset (the `kiricons` kiro.svg shipped in the
 *  app, identical to the kiro.dev favicon mark); simple-icons carries no
 *  Kiro entry. The source's three subpaths (ghost outline ring + two eyes)
 *  combine into one path — nonzero fill preserves the ring and the eyes.
 *  Native viewBox is 17×16; the transform scales it to ~20px tall, centered
 *  in the shared 24×24 box. Official hex #9046FF (kiro.dev favicon ground). */
export const IconKiro = brandIcon(
  'kiro',
  'M8.74842 1C10.9904 0.997658 13.2522 2.35131 14.0873 4.98145L14.1635 5.24024L14.2631 5.65918C14.5302 6.92198 14.9273 10.1 13.1898 13.249L13.1888 13.25C12.6834 14.1641 11.7454 15.0605 10.7611 15.459C10.2633 15.6604 9.62658 15.7841 8.99744 15.5586C8.737 15.4652 8.51267 15.3237 8.32166 15.1465C7.29212 15.6815 6.13882 15.8407 5.18983 15.4424C4.52211 15.1621 3.99817 14.61 3.80799 13.8301C3.7494 13.5896 3.72834 13.3402 3.73572 13.084C3.20222 13.0354 2.72563 12.8114 2.39197 12.3281C2.12296 11.9385 2.05135 11.4999 2.06385 11.1397C2.07645 10.7768 2.17568 10.4166 2.33729 10.1113L2.34022 10.1064L2.62537 9.56934C2.69173 9.43932 2.7378 9.34011 2.77772 9.23438C2.93103 8.8105 2.97379 8.57168 3.04041 8.11328L3.04139 8.11133L3.08631 7.77051C3.12624 7.43395 3.15342 7.10561 3.19569 6.72657C3.24643 6.27143 3.31804 5.77596 3.46424 5.28809C4.13106 2.4575 6.43044 1.00258 8.74842 1ZM13.1986 5.50391C11.9212 0.832507 5.53387 0.824247 4.43494 5.52735C4.17712 6.35134 4.1734 7.28628 4.03065 8.25684L3.97694 8.59864C3.92246 8.91789 3.85695 9.19102 3.71717 9.57715C3.6061 9.87417 3.45901 10.1355 3.22108 10.5791L3.15858 10.7148C2.88165 11.4262 3.12847 12.5525 4.89881 11.9063L5.06776 11.8311C3.75892 14.732 6.55455 15.4597 8.61658 13.7607C9.18562 15.5472 11.2185 14.4089 12.1439 13.042L12.3138 12.7666C13.8864 9.9168 13.5268 7.01816 13.2875 5.87891L13.1986 5.50391Z M8.86245 7.52841C8.33877 7.52841 8.25943 6.90239 8.25943 6.52994C8.25943 6.19316 8.31894 5.92769 8.43399 5.75732C8.53317 5.60676 8.67996 5.53148 8.86245 5.53148C9.04495 5.53148 9.20364 5.60676 9.31472 5.76128C9.44167 5.93562 9.50912 6.20108 9.50912 6.52994C9.50912 7.15597 9.26711 7.52841 8.86642 7.52841H8.86245Z M11.0166 7.52841C10.4929 7.52841 10.4136 6.90239 10.4136 6.52994C10.4136 6.19316 10.4731 5.92769 10.5881 5.75732C10.6873 5.60676 10.8341 5.53148 11.0166 5.53148C11.1991 5.53148 11.3578 5.60676 11.4689 5.76128C11.5958 5.93562 11.6633 6.20108 11.6633 6.52994C11.6633 7.15597 11.4213 7.52841 11.0206 7.52841H11.0166Z',
  'translate(0.8 0.67) scale(1.346)',
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
  kiro: IconKiro,
  zed: IconZed,
  iterm2: IconIterm2,
  windowsterminal: IconWindowsTerminal,
}
