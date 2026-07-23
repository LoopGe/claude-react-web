// PluginContextMenu — renders plugin-contributed context-menu items for a
// location at a screen coordinate, using the existing <ContextMenu> visual +
// dismissal behaviour. The caller opens it on a `contextmenu` gesture and
// supplies the gesture's MenuContext (built e.g. via buildSelectionContext).
//
// This is the host a future MessageList wiring mounts on right-click; it has
// its own registry + keyboard accessibility via <ContextMenu>.

import { useMemo } from 'react'
import { ContextMenu, type ContextMenuItem } from '../components/ContextMenu'
import { usePluginContextMenu } from './usePluginContextMenu'
import type { MenuContext } from './usePluginContextMenu'
import type { PluginContextMenuContribution } from '../../shared/app-plugins/contributions.js'

interface Props {
  open: boolean
  x: number
  y: number
  location: PluginContextMenuContribution['location']
  context: MenuContext | null
  onClose: () => void
}

export function PluginContextMenu({ open, x, y, location, context, onClose }: Props) {
  const { buildItems } = usePluginContextMenu(location)
  const items: ContextMenuItem[] = useMemo(
    () => (open && context ? buildItems(context) : []),
    [open, context, buildItems],
  )
  if (!open || items.length === 0) return null
  return <ContextMenu x={x} y={y} items={items} onClose={onClose} />
}
