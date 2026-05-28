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
