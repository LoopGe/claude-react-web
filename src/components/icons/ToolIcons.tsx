// Inline SVG icons for tool cards.
//
// We deliberately avoid pulling in lucide-react / @heroicons — the bundle
// matters (this lives in the message list which is render-hot) and the
// icon set we need is small enough that hand-rolled inline SVGs cost less
// than a tree-shaken dependency.
//
// All icons share the same shape: 14×14 viewBox 24, stroke-based
// (currentColor), round caps/joins. Inheriting `color` from the parent
// means a single CSS variable can theme the whole set.
//
// Stroke width is *size-aware*: because every icon draws in a 24-unit
// viewBox but renders at 11–18px, a fixed stroke-width lands on a
// fractional device-pixel width (e.g. 1.75 × 14/24 ≈ 1.02px) and the
// antialiaser smears it into a soft, gray line. We instead solve for the
// stroke that renders at a constant ~1.5 CSS px at the icon's actual size,
// so a 12px and an 18px icon carry the same crisp optical weight. Callers
// can still override via the `strokeWidth` prop.
//
// Source: Lucide icon outlines (MIT-licensed) traced for a consistent
// optical weight at 14px — the size every tool card uses.

import type { SVGProps } from 'react'

type IconProps = Omit<SVGProps<SVGSVGElement>, 'children' | 'strokeWidth'> & {
  size?: number
}

// Target rendered stroke width in CSS pixels. 1.5px reads crisp at the
// sizes this set uses without looking heavy. Never let the solved stroke
// drop below this in viewBox units, so very large icons don't go hairline.
const TARGET_STROKE_PX = 1.5

function Icon({
  size = 14,
  children,
  strokeWidth,
  style,
  ...rest
}: IconProps & { strokeWidth?: number; children: React.ReactNode }) {
  // Solve for the viewBox stroke that renders at TARGET_STROKE_PX once the
  // 24-unit viewBox is scaled down to `size` px: stroke × (size/24) = target.
  const resolvedStroke =
    strokeWidth ?? Math.max(TARGET_STROKE_PX, (TARGET_STROKE_PX * 24) / size)
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={resolvedStroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      // A bare inline <svg> sits on the text baseline, so it appears to sag
      // below adjacent text by its descender gap (the reason call sites grew
      // one-off `verticalAlign: '-2px'` patches). Shifting down 0.125em aligns
      // the icon's optical center to the text x-height in inline contexts;
      // flex/grid parents ignore vertical-align and center via align-items,
      // so this is harmless there. Caller-supplied style still wins.
      style={{ verticalAlign: '-0.125em', ...style }}
      {...rest}
    >
      {children}
    </svg>
  )
}

export function IconSearch(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </Icon>
  )
}

export function IconGlobe(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a14 14 0 0 1 0 18" />
      <path d="M12 3a14 14 0 0 0 0 18" />
    </Icon>
  )
}

export function IconWebSearch(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="m20 20-4.5-4.5" />
      <path d="M4.8 10.5h11.4" />
      <path d="M10.5 4.5a9 9 0 0 1 0 12" />
      <path d="M10.5 4.5a9 9 0 0 0 0 12" />
    </Icon>
  )
}

export function IconFolderSearch(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 6.5a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v3.5" />
      <circle cx="14" cy="15" r="3.5" />
      <path d="m18.5 19.5-2-2" />
      <path d="M3 9v9a2 2 0 0 0 2 2h4" />
    </Icon>
  )
}

export function IconFileText(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
      <path d="M14 3v6h6" />
      <path d="M8 13h8" />
      <path d="M8 17h6" />
    </Icon>
  )
}

export function IconFileCode(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
      <path d="M14 3v6h6" />
      <path d="m9.5 13-2 2 2 2" />
      <path d="m14.5 13 2 2-2 2" />
    </Icon>
  )
}

export function IconLink(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" />
    </Icon>
  )
}

export function IconListTodo(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3" y="5" width="6" height="6" rx="1.5" />
      <path d="m5.5 8 1 1 2-2.5" />
      <path d="M12 7h9" />
      <path d="M3 17h6" />
      <path d="M12 17h9" />
    </Icon>
  )
}

export function IconMessageQuestion(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M21 12c0 4.42-3.58 8-8 8a8.96 8.96 0 0 1-3.93-.9L4 20l1-4.5A8 8 0 1 1 21 12Z" />
      <path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 1-1 1.7" />
      <circle cx="12" cy="16" r="0.5" fill="currentColor" stroke="none" />
    </Icon>
  )
}

export function IconCheck(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m5 12 5 5L20 7" />
    </Icon>
  )
}

export function IconCheckCircle(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12 3 3 5-6" />
    </Icon>
  )
}

export function IconCircleDot(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
    </Icon>
  )
}

export function IconCircle(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
    </Icon>
  )
}

// Square checkbox variants of IconCircle / IconCircleDot, used by the
// Checklist under the High-Contrast skin so the pending / in-progress
// markers are right-angled like the rest of HC UI (the circular variants
// draw their roundness in the SVG path, which border-radius can't touch).
// Same 24×24 viewBox + r=9 footprint as the circles so they swap 1:1.
export function IconCheckbox(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3" y="3" width="18" height="18" rx="0" />
    </Icon>
  )
}

export function IconCheckboxDot(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3" y="3" width="18" height="18" rx="0" />
      <rect x="9" y="9" width="6" height="6" rx="0" fill="currentColor" stroke="none" />
    </Icon>
  )
}

export function IconCopy(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </Icon>
  )
}

export function IconLoader(props: IconProps) {
  // The loader rotates at the .tool-status-running CSS rule. We render
  // a partial arc so rotation is perceptible — a full circle wouldn't
  // appear to spin.
  return (
    <Icon {...props}>
      <path d="M12 3a9 9 0 1 0 9 9" />
    </Icon>
  )
}

export function IconAlertCircle(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v4.5" />
      <circle cx="12" cy="16" r="0.5" fill="currentColor" stroke="none" />
    </Icon>
  )
}

export function IconTerminal(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m7 9 3 3-3 3" />
      <path d="M13 15h4" />
    </Icon>
  )
}

export function IconClipboardList(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="6" y="4" width="12" height="17" rx="2" />
      <rect x="9" y="2.5" width="6" height="3" rx="0.8" />
      <path d="M9 11h6" />
      <path d="M9 15h4" />
    </Icon>
  )
}

export function IconNotebook(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <path d="M9 3v18" />
      <path d="M12 8h4" />
      <path d="M12 12h4" />
    </Icon>
  )
}

export function IconExternalLink(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M14 4h6v6" />
      <path d="m20 4-9 9" />
      <path d="M19 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5" />
    </Icon>
  )
}

export function IconShield(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6Z" />
      <path d="M12 8v4" />
      <circle cx="12" cy="15" r="0.5" fill="currentColor" stroke="none" />
    </Icon>
  )
}

// ── General-purpose UI glyphs (replacing emoji used as structural icons) ──

export function IconX(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 6 18 18" />
      <path d="M18 6 6 18" />
    </Icon>
  )
}

export function IconPaperclip(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M20 11.5 11.5 20a4.5 4.5 0 0 1-6.4-6.4l8.5-8.5a3 3 0 0 1 4.3 4.3l-8.5 8.5a1.5 1.5 0 0 1-2.1-2.1l7.8-7.8" />
    </Icon>
  )
}

export function IconDownload(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 4v11" />
      <path d="m7 11 5 5 5-5" />
      <path d="M5 20h14" />
    </Icon>
  )
}

export function IconArrowDown(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 5v14" />
      <path d="m6 13 6 6 6-6" />
    </Icon>
  )
}

export function IconArrowLeft(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M19 12H5" />
      <path d="m12 19-7-7 7-7" />
    </Icon>
  )
}

export function IconClock(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </Icon>
  )
}

export function IconSettings(props: IconProps) {
  // A 6-tooth gear whose teeth reach only to ~r=7 (the same optical bound as
  // the search circle), so it sits visually level with the rest of the header
  // set. The previous Lucide gear filled the 24-unit box edge-to-edge and
  // needed a scale(0.86) + non-scaling-stroke patch to look right; this
  // geometry needs neither — its stroke thins with `size` like every other
  // icon, keeping a uniform 1.5px optical weight across the set.
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M18.79 10.31L18.79 13.69L17 13.43L15.74 15.61L16.86 17.04L13.93 18.73L13.26 17.05L10.74 17.05L10.07 18.73L7.14 17.04L8.26 15.61L7 13.43L5.21 13.69L5.21 10.31L7 10.57L8.26 8.39L7.14 6.96L10.07 5.27L10.74 6.95L13.26 6.95L13.93 5.27L16.86 6.96L15.74 8.39L17 10.57Z" />
    </Icon>
  )
}

export function IconZap(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M13 2 4 14h7l-1 8 9-12h-7z" />
    </Icon>
  )
}

export function IconPencil(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
      <path d="m14.5 5.5 3 3" />
    </Icon>
  )
}

export function IconBot(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="4" y="8" width="16" height="11" rx="2" />
      <path d="M12 8V4" />
      <circle cx="12" cy="3.5" r="1" fill="currentColor" stroke="none" />
      <circle cx="9" cy="13" r="0.6" fill="currentColor" stroke="none" />
      <circle cx="15" cy="13" r="0.6" fill="currentColor" stroke="none" />
      <path d="M9.5 16h5" />
    </Icon>
  )
}

export function IconClipboard(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="6" y="4" width="12" height="17" rx="2" />
      <rect x="9" y="2.5" width="6" height="3" rx="0.8" />
    </Icon>
  )
}

/** Workflow / multi-agent orchestration icon — three connected nodes
 *  (a share-graph glyph). Reads as "fan-out across agents" at a glance,
 *  distinct from the single-bot IconBot used by plain subagents. */
export function IconWorkflow(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="6" cy="6" r="2.4" />
      <circle cx="18" cy="6" r="2.4" />
      <circle cx="12" cy="18" r="2.4" />
      <path d="M7.6 7.6 10.6 16" />
      <path d="M16.4 7.6 13.4 16" />
      <path d="M8.4 6h7.2" />
    </Icon>
  )
}

export function IconBell(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9Z" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </Icon>
  )
}
export function IconBellToggle(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9Z" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
      <path className="notification-icon-slash" d="m2 2 20 20" pathLength={1} />
    </Icon>
  )
}

export function IconBellOff(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8.7 3.7A6 6 0 0 1 18 8c0 3 .6 5.1 1.3 6.5" />
      <path d="M17 17H3s3-2 3-9c0-.7.1-1.4.3-2" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
      <path d="m2 2 20 20" />
    </Icon>
  )
}

export function IconVolume2(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M11 5 6 9H2v6h4l5 4V5Z" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7" />
      <path d="M19 5a10 10 0 0 1 0 14" />
    </Icon>
  )
}

export function IconVolumeX(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M11 5 6 9H2v6h4l5 4V5Z" />
      <path d="m16 9 6 6" />
      <path d="m22 9-6 6" />
    </Icon>
  )
}

export function IconFolder(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 6.5a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </Icon>
  )
}

export function IconRefresh(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M21 12a9 9 0 1 1-2.6-6.4" />
      <path d="M21 4v5h-5" />
    </Icon>
  )
}

// Counter-clockwise "undo" rotate — used for "discard / revert" affordances
// where IconRefresh's direction (forward refresh) would be semantically wrong.
export function IconRotateCcw(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 12a9 9 0 1 0 2.6-6.4" />
      <path d="M3 4v5h5" />
    </Icon>
  )
}

// Git branch glyph — two-node fork with a connector. Traced from Lucide
// `git-branch` so it sits in the same optical family as the rest of the set.
export function IconGitBranch(props: IconProps) {
  return (
    <Icon {...props}>
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </Icon>
  )
}

// Git fork glyph — two parent nodes joined to a child below. Traced from
// Lucide `git-fork` so it sits in the same optical family as IconGitBranch.
export function IconGitFork(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="6" cy="6" r="3" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="12" cy="18" r="3" />
      <path d="M18 9v1.5a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V9" />
      <path d="M12 12.5V15" />
    </Icon>
  )
}

export function IconChevronRight(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m9 6 6 6-6 6" />
    </Icon>
  )
}

export function IconChevronDown(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m6 9 6 6 6-6" />
    </Icon>
  )
}

export function IconChevronUp(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m6 15 6-6 6 6" />
    </Icon>
  )
}

export function IconArrowUp(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 20V4" />
      <path d="m7 9 5-5 5 5" />
    </Icon>
  )
}

export function IconTrash(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 7h16" />
      <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
      <path d="M6 7v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7" />
      <path d="M10 11v6M14 11v6" />
    </Icon>
  )
}

export function IconAlertTriangle(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M10.3 4.3 2.6 18a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </Icon>
  )
}

export function IconSquare(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="4" y="4" width="16" height="16" rx="2" />
    </Icon>
  )
}
export function IconSendInterruptToggle(props: IconProps) {
  return (
    <Icon {...props}>
      <g className="composer-toggle-send">
        <path className="composer-toggle-send-line" d="M12 20V4" pathLength={1} />
        <path className="composer-toggle-send-head" d="m7 9 5-5 5 5" pathLength={1} />
      </g>
      <rect className="composer-toggle-stop" x="5" y="5" width="14" height="14" rx="2" pathLength={1} />
    </Icon>
  )
}

export function IconInfo(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" />
      <circle cx="12" cy="8" r="0.5" fill="currentColor" stroke="none" />
    </Icon>
  )
}

export function IconCheckSquare(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9" />
      <path d="m9 11 3 3 8-8" />
    </Icon>
  )
}

export function IconUser(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20a8 8 0 0 1 16 0" />
    </Icon>
  )
}

export function IconBug(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="8" y="6" width="8" height="13" rx="4" />
      <path d="M9 3.5 10.5 6M15 3.5 13.5 6" />
      <path d="M8 11H4M8 15H4M16 11h4M16 15h4M8 8 5 6M16 8l3-2M8 18l-3 2M16 18l3 2" />
    </Icon>
  )
}

export function IconBugOff(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M16 9v6a4 4 0 0 1-7 2.6" />
      <path d="M8 13v-2a4 4 0 0 1 4-4" />
      <path d="M15 3.5 13.5 6M8 11H4M8 15H4M16 11h4M8 8 5 6M8 18l-3 2" />
      <path d="m3 3 18 18" />
    </Icon>
  )
}

export function IconSparkles(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3.5c.6 3.4 1.6 4.4 5 5-3.4.6-4.4 1.6-5 5-.6-3.4-1.6-4.4-5-5 3.4-.6 4.4-1.6 5-5Z" />
      <path d="M18.5 14c.3 1.6.8 2.1 2.4 2.5-1.6.3-2.1.8-2.4 2.5-.3-1.7-.8-2.2-2.5-2.5 1.7-.4 2.2-.9 2.5-2.5Z" />
    </Icon>
  )
}

export function IconMessageCircle(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M21 11.5a8 8 0 0 1-11.7 7.1L4 20l1.4-5.3A8 8 0 1 1 21 11.5Z" />
    </Icon>
  )
}

/** Brain (extended thinking) — lucide "brain" outline. Used by the
 *  ChatPanel thinking chip. */
export function IconBrain(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
      <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
      <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
      <path d="M17.599 6.5a3 3 0 0 0 .399-1.375" />
      <path d="M6.003 5.125A3 3 0 0 0 6.401 6.5" />
      <path d="M3.477 10.896a4 4 0 0 1 .585-.396" />
      <path d="M19.938 10.5a4 4 0 0 1 .585.396" />
      <path d="M6 18a4 4 0 0 1-1.967-.516" />
      <path d="M19.967 17.484A4 4 0 0 1 18 18" />
    </Icon>
  )
}

export function IconDollar(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3v18" />
      <path d="M16 7.5a3.5 3.5 0 0 0-3.5-2.5h-1A3.25 3.25 0 0 0 11 11.5h2a3.25 3.25 0 0 1 .5 6.5h-1.5A3.5 3.5 0 0 1 8 15.5" />
    </Icon>
  )
}

export function IconWrench(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M14.5 6a3.5 3.5 0 0 0-4.6 4.3L4 16.2a2 2 0 0 0 2.8 2.8l5.9-5.9A3.5 3.5 0 0 0 18 9.5a3.5 3.5 0 0 0-1-2.4l-2.2 2.2-1.6-1.6L15.4 5.5A3.5 3.5 0 0 0 14.5 6Z" />
    </Icon>
  )
}

export function IconMoon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z" />
    </Icon>
  )
}

export function IconSun(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19" />
    </Icon>
  )
}

export function IconMonitor(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </Icon>
  )
}

export function IconScissors(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <path d="M8 7.5 20 18M8 16.5 20 6M8.2 11.5 12 13" />
    </Icon>
  )
}

export function IconLock(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="4" y="10" width="16" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </Icon>
  )
}

export function IconMenu(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 6h16" />
      <path d="M4 12h16" />
      <path d="M4 18h16" />
    </Icon>
  )
}

export function IconSidebar(props: IconProps) {
  return (
    <Icon {...props}>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M9 3v18" />
    </Icon>
  )
}
