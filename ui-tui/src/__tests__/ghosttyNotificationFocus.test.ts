import { describe, expect, it, vi } from 'vitest'

import {
  buildGhosttyPresentSurfaceArgs,
  resolveGhosttyFocusTarget,
  spawnGhosttyPresentSurface
} from '../app/ghosttyNotificationFocus.js'

describe('Ghostty notification focus', () => {
  it('resolves the class-derived D-Bus target from an explicit app id override', () => {
    expect(
      resolveGhosttyFocusTarget({
        GHOSTTY_SURFACE_ID: '0xca6e0ea203737901',
        HERMES_GHOSTTY_APP_ID: 'com.mitchellh.ghostty.tip'
      })
    ).toEqual({
      destination: 'com.mitchellh.ghostty.tip',
      objectPath: '/com/mitchellh/ghostty/tip',
      surfaceId: '0xca6e0ea203737901'
    })
  })

  it('infers the side-by-side ghostty-tip D-Bus target from the private install path', () => {
    expect(
      resolveGhosttyFocusTarget({
        GHOSTTY_BIN_DIR: '/home/volt/.local/opt/ghostty-tip/bin',
        GHOSTTY_SURFACE_ID: '0x016ffcc51bed19c1'
      })
    ).toEqual({
      destination: 'com.mitchellh.ghostty.tip',
      objectPath: '/com/mitchellh/ghostty/tip',
      surfaceId: '0x016ffcc51bed19c1'
    })
  })

  it('falls back to the default Ghostty app id for normal installs', () => {
    expect(resolveGhosttyFocusTarget({ GHOSTTY_SURFACE_ID: '12345' })).toEqual({
      destination: 'com.mitchellh.ghostty',
      objectPath: '/com/mitchellh/ghostty',
      surfaceId: '12345'
    })
  })

  it('can be disabled without changing notification delivery', () => {
    expect(
      resolveGhosttyFocusTarget({
        GHOSTTY_SURFACE_ID: '12345',
        HERMES_GHOSTTY_NOTIFICATION_FOCUS: '0'
      })
    ).toBeNull()
  })

  it('ignores malformed surface ids', () => {
    expect(resolveGhosttyFocusTarget({ GHOSTTY_SURFACE_ID: 'not-a-surface' })).toBeNull()
    expect(resolveGhosttyFocusTarget({ GHOSTTY_SURFACE_ID: '0' })).toBeNull()
  })

  it('builds the present-surface gdbus activation command', () => {
    expect(
      buildGhosttyPresentSurfaceArgs({
        destination: 'com.mitchellh.ghostty.tip',
        objectPath: '/com/mitchellh/ghostty/tip',
        surfaceId: '0xca6e0ea203737901'
      })
    ).toEqual([
      'call',
      '--session',
      '--dest',
      'com.mitchellh.ghostty.tip',
      '--object-path',
      '/com/mitchellh/ghostty/tip',
      '--method',
      'org.gtk.Actions.Activate',
      'present-surface',
      '[<uint64 0xca6e0ea203737901>]',
      '{}'
    ])
  })

  it('spawns gdbus without blocking the TUI process', () => {
    const child = { unref: vi.fn() }
    const spawn = vi.fn(() => child)

    spawnGhosttyPresentSurface(
      {
        destination: 'com.mitchellh.ghostty.tip',
        objectPath: '/com/mitchellh/ghostty/tip',
        surfaceId: '0xca6e0ea203737901'
      },
      spawn
    )

    expect(spawn).toHaveBeenCalledWith(
      'gdbus',
      [
        'call',
        '--session',
        '--dest',
        'com.mitchellh.ghostty.tip',
        '--object-path',
        '/com/mitchellh/ghostty/tip',
        '--method',
        'org.gtk.Actions.Activate',
        'present-surface',
        '[<uint64 0xca6e0ea203737901>]',
        '{}'
      ],
      { detached: true, stdio: 'ignore' }
    )
    expect(child.unref).toHaveBeenCalled()
  })
})
