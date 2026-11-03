/* eslint-disable react-refresh/only-export-components -- icon barrel: every export IS a component, but the rule can't see through the L() factory */

// Icon set for tool cards and general UI chrome.
//
// Since this revision the glyph PATHS come from lucide-react (the upstream
// MIT set) instead of hand-traced copies. The module stays the SINGLE icon
// import surface: call sites never import lucide-react directly. Adding an
// icon is one line — `export const IconFoo = L(Foo)` (browse names at
// lucide.dev) — never redraw paths by hand.
//
// The `L` wrapper preserves the optical system the hand-drawn set was built
// around:
//
// - **Size-aware stroke.** A fixed viewBox stroke-width lands on a
//   fractional device-pixel width when a 24-unit viewBox renders at 11–18px
//   (e.g. lucide's default 2 × 14/24 ≈ 1.17px) and the antialiaser smears it
//   into a soft, gray line. `strokeWidth={1.5} absoluteStrokeWidth` makes
//   lucide solve the same equation the old hand-rolled `Icon` did —
//   stroke × (size/24) = 1.5 CSS px — so a 12px and an 18px icon carry the
//   same crisp optical weight. A caller-supplied `strokeWidth` is forwarded
//   verbatim (viewBox units, lucide's normal scaling), matching the old
//   override semantics.
// - **Baseline alignment.** A bare inline <svg> sits on the text baseline and
//   sags below adjacent text by its descender gap (the reason call sites grew
//   one-off `verticalAlign: '-2px'` patches). Shifting down 0.125em aligns
//   the icon's optical center to the text x-height in inline contexts;
//   flex/grid parents ignore vertical-align and center via align-items.
//   Caller-supplied `style` still wins.
// - `aria-hidden` by default; callers can override.
//
// Every glyph in this file is lucide-backed — there are no hand-drawn paths
// left. Two exports carry a thin wrapper for non-path reasons:
//
// - `IconLoader` — adds the always-on `icon-loader` class that the stylesheet
//   spins by (`.tool-status-running .icon-loader`), merged with caller
//   className.
//
// State-dependent glyphs (bell on/off, composer send⇄stop) are NOT single
// components any more: call sites stack two lucide glyphs in one slot and
// crossfade them via the shared `slot-morph` recipe (see utilities.css).

import type { SVGProps } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowLeft,
  ArrowUp,
  Bell,
  BellOff,
  Bot,
  Brain,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleDot,
  Clipboard,
  ClipboardList,
  Clock,
  Copy,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  FileCode,
  FileText,
  Folder,
  FolderSearch,
  Gauge,
  GitBranch,
  GitFork,
  Globe,
  Info,
  Layers,
  ListTodo,
  LoaderCircle,
  Lock,
  Menu,
  MessageCircle,
  MessageCircleQuestion,
  Minus,
  Monitor,
  Moon,
  Notebook,
  PanelLeft,
  Paperclip,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Scissors,
  Search,
  Settings,
  ShieldAlert,
  Sparkles,
  Square,
  SquareCheck,
  SquareDot,
  SquareTerminal,
  Sun,
  Trash2,
  TriangleAlert,
  User,
  VenetianMask,
  Volume2,
  VolumeX,
  Workflow,
  X,
  Zap,
} from 'lucide-react'

type IconProps = Omit<SVGProps<SVGSVGElement>, 'children'> & {
  size?: number
  strokeWidth?: number
}

// Target rendered stroke width in CSS pixels. 1.5px reads crisp at the
// sizes this set uses without looking heavy. (Lucide's stock default of 2
// viewBox units renders ~1.17px at 14px — see the header note.)
const TARGET_STROKE_PX = 1.5

/** Wrap a lucide component with this set's stroke / baseline / a11y policy. */
function L(Lucide: LucideIcon) {
  function Icon({ size = 14, strokeWidth, style, ...rest }: IconProps) {
    return (
      <Lucide
        size={size}
        aria-hidden
        strokeWidth={strokeWidth ?? TARGET_STROKE_PX}
        absoluteStrokeWidth={strokeWidth == null}
        style={{ verticalAlign: '-0.125em', ...style }}
        {...rest}
      />
    )
  }
  Icon.displayName = `Icon(${Lucide.displayName ?? Lucide.name ?? 'Lucide'})`
  return Icon
}

// ── Lucide-backed glyphs ─────────────────────────────────────────────────────
// IconName → lucide name; renames: Trash→Trash2, AlertCircle→CircleAlert,
// AlertTriangle→TriangleAlert, CheckCircle→CircleCheck, Terminal→SquareTerminal,
// Shield (exclamation variant)→ShieldAlert, Sidebar→PanelLeft, Refresh→RefreshCw,
// MessageQuestion→MessageCircleQuestion, Mask→VenetianMask, Loader→LoaderCircle,
// Checkbox→Square, CheckboxDot→SquareDot.

export const IconSearch = L(Search)
export const IconSettings = L(Settings)
export const IconGlobe = L(Globe)
export const IconFolderSearch = L(FolderSearch)
export const IconFileText = L(FileText)
export const IconFileCode = L(FileCode)
export const IconListTodo = L(ListTodo)
// `.tool-status-running .icon-loader` (utilities.css) spins THE LOADER by
// class rather than "any svg inside a badge", so the class must survive the
// lucide swap.
const IconLoaderBase = L(LoaderCircle)
export function IconLoader({ className, ...props }: IconProps) {
  return (
    <IconLoaderBase
      {...props}
      className={className ? `icon-loader ${className}` : 'icon-loader'}
    />
  )
}
export const IconCheck = L(Check)
export const IconCheckCircle = L(CircleCheck)
export const IconCircleDot = L(CircleDot)
export const IconCircle = L(Circle)
export const IconCopy = L(Copy)
export const IconAlertCircle = L(CircleAlert)
export const IconTerminal = L(SquareTerminal)
export const IconClipboardList = L(ClipboardList)
export const IconNotebook = L(Notebook)
export const IconExternalLink = L(ExternalLink)
export const IconShield = L(ShieldAlert)
export const IconX = L(X)
export const IconPaperclip = L(Paperclip)
export const IconDownload = L(Download)
export const IconArrowDown = L(ArrowDown)
export const IconArrowDownToLine = L(ArrowDownToLine)
export const IconArrowLeft = L(ArrowLeft)
export const IconClock = L(Clock)
export const IconZap = L(Zap)
export const IconGauge = L(Gauge)
export const IconLayers = L(Layers)
export const IconPencil = L(Pencil)
export const IconBot = L(Bot)
export const IconClipboard = L(Clipboard)
export const IconWorkflow = L(Workflow)
export const IconBell = L(Bell)
export const IconBellOff = L(BellOff)
export const IconVolume2 = L(Volume2)
export const IconVolumeX = L(VolumeX)
export const IconFolder = L(Folder)
export const IconRefresh = L(RefreshCw)
export const IconRotateCcw = L(RotateCcw)
export const IconGitBranch = L(GitBranch)
export const IconGitFork = L(GitFork)
export const IconChevronRight = L(ChevronRight)
export const IconChevronDown = L(ChevronDown)
export const IconChevronUp = L(ChevronUp)
export const IconChevronLeft = L(ChevronLeft)
export const IconPlus = L(Plus)
export const IconMinus = L(Minus)
export const IconArrowUp = L(ArrowUp)
export const IconTrash = L(Trash2)
export const IconAlertTriangle = L(TriangleAlert)
export const IconSquare = L(Square)
export const IconInfo = L(Info)
export const IconCheckSquare = L(SquareCheck)
export const IconUser = L(User)
export const IconSparkles = L(Sparkles)
export const IconMessageCircle = L(MessageCircle)
export const IconMessageQuestion = L(MessageCircleQuestion)
export const IconBrain = L(Brain)
export const IconEye = L(Eye)
export const IconEyeOff = L(EyeOff)
export const IconMoon = L(Moon)
export const IconSun = L(Sun)
export const IconMonitor = L(Monitor)
export const IconScissors = L(Scissors)
export const IconLock = L(Lock)
export const IconMenu = L(Menu)
export const IconSidebar = L(PanelLeft)
/** Theatre mask (lucide's venetian-mask) — the main thread's PERSONA
 *  (custom agent). Deliberately not IconBot: that glyph is already the
 *  `auto` permission mode's, and the two chips sit side by side. */
export const IconMask = L(VenetianMask)

// Square checkbox variants of IconCircle / IconCircleDot, used by the
// Checklist under the High-Contrast skin. NOTE: lucide's Square carries its
// own ~2-unit corner rounding in the path, so under the HC skin these read
// slightly rounded — accepted when the set moved fully to lucide (the old
// rx=0 rects are in git history if HC ever needs true right angles back).
export const IconCheckbox = L(Square)
export const IconCheckboxDot = L(SquareDot)
