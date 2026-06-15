import { describe, expect, it } from 'vitest'
import {
  isPlanApprovalTargetMode,
  isUserSelectablePermissionMode,
  PLAN_APPROVAL_TARGET_MODES,
  USER_SELECTABLE_PERMISSION_MODES,
} from './permission-modes.js'

describe('permission mode allowlists', () => {
  it('keeps auto out of user-selectable modes on this backend', () => {
    expect(USER_SELECTABLE_PERMISSION_MODES).toEqual([
      'default',
      'acceptEdits',
      'plan',
      'bypassPermissions',
      'dontAsk',
    ])
    expect(isUserSelectablePermissionMode('auto')).toBe(false)
    expect(isUserSelectablePermissionMode('default')).toBe(true)
  })

  it('allows plan approval to exit only into execution modes', () => {
    expect(PLAN_APPROVAL_TARGET_MODES).toEqual(['default', 'acceptEdits', 'bypassPermissions'])
    expect(isPlanApprovalTargetMode('plan')).toBe(false)
    expect(isPlanApprovalTargetMode('dontAsk')).toBe(false)
    expect(isPlanApprovalTargetMode('auto')).toBe(false)
    expect(isPlanApprovalTargetMode('acceptEdits')).toBe(true)
  })
})
