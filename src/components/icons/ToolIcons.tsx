// Inline SVG icons for tool cards.
//
// We deliberately avoid pulling in lucide-react / @heroicons — the bundle
// matters (this lives in the message list which is render-hot) and the
// icon set we need is small enough that hand-rolled inline SVGs cost less
// than a tree-shaken dependency.
//
// All icons share the same shape: 14×14 viewBox 24, stroke-based
// (currentColor), stroke-width 1.75, round caps/joins. Inheriting `color`
// from the parent means a single CSS variable can theme the whole set.
//
// Source: Lucide icon outlines (MIT-licensed) traced for a consistent
// optical weight at 14px — the size every tool card uses.

import type { SVGProps } from 'react'

type IconProps = Omit<SVGProps<SVGSVGElement>, 'children' | 'strokeWidth'> & {
  size?: number
}

function Icon({
  size = 14,
  children,
  strokeWidth = 1.75,
  ...rest
}: IconProps & { strokeWidth?: number; children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
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

export function IconClock(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </Icon>
  )
}

export function IconSettings(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z" />
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

export function IconBell(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
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
