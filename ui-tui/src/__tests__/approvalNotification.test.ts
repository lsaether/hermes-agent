import { describe, expect, it, vi } from 'vitest'

import { sendApprovalNotification } from '../app/approvalNotification.js'

const fakeStdout = () => ({ isTTY: true, write: vi.fn() })

const fakeChild = () => {
  const handlers: Record<string, (...args: any[]) => void> = {}
  const stdoutHandlers: Record<string, (...args: any[]) => void> = {}

  const stdout = {
    on: vi.fn((event: string, cb: (...args: any[]) => void) => {
      stdoutHandlers[event] = cb

      return stdout
    }),
    setEncoding: vi.fn(),
    unref: vi.fn()
  }

  const child = {
    once: vi.fn((event: string, cb: (...args: any[]) => void) => {
      handlers[event] = cb

      return child
    }),
    stdout,
    unref: vi.fn()
  }

  return { child, handlers, stdoutHandlers }
}

describe('approval notifications', () => {
  it('uses notify-send with the attention title and description-only body', () => {
    const stdout = fakeStdout()
    const { child } = fakeChild()
    const spawn = vi.fn(() => child)

    sendApprovalNotification({
      description: 'Dangerous command approval needed',
      env: { WAYLAND_DISPLAY: 'wayland-1' },
      iconPath: '/repo/website/static/img/logo.png',
      method: 'native',
      platform: 'linux',
      spawn,
      stdout: stdout as any
    })

    expect(spawn).toHaveBeenCalledWith(
      'notify-send',
      [
        '--app-name=Hermes',
        '--icon=/repo/website/static/img/logo.png',
        '--transient',
        '⚠ Attention Required',
        'Dangerous command approval needed'
      ],
      { detached: true, stdio: 'ignore' }
    )
    expect(child.unref).toHaveBeenCalled()
    expect(stdout.write).not.toHaveBeenCalled()
  })

  it('sanitizes approval descriptions before showing them in native notifications', () => {
    const stdout = fakeStdout()
    const { child } = fakeChild()
    const spawn = vi.fn(() => child)

    sendApprovalNotification({
      description: 'Dangerous\u0000command\napproval\u001b[31m needed',
      env: { WAYLAND_DISPLAY: 'wayland-1' },
      iconPath: '/repo/website/static/img/logo.png',
      method: 'native',
      platform: 'linux',
      spawn,
      stdout: stdout as any
    })

    expect(spawn).toHaveBeenCalledWith(
      'notify-send',
      expect.arrayContaining(['⚠ Attention Required', 'Dangerous command approval needed']),
      { detached: true, stdio: 'ignore' }
    )
  })

  it('uses the same OSC 9 backend path as completion notifications', () => {
    const stdout = fakeStdout()
    const spawn = vi.fn()

    sendApprovalNotification({
      description: 'dangerous command',
      env: { TERM: 'xterm-ghostty' },
      method: 'osc9',
      platform: 'linux',
      spawn,
      stdout: stdout as any
    })

    expect(spawn).not.toHaveBeenCalled()
    expect(stdout.write).toHaveBeenCalledWith('\x1b]9;⚠ Attention Required: dangerous command\x07')
  })

  it('uses BEL through the shared terminal notification backend when requested', () => {
    const stdout = fakeStdout()
    const spawn = vi.fn()

    sendApprovalNotification({
      description: 'dangerous command',
      method: 'bel',
      platform: 'linux',
      spawn,
      stdout: stdout as any
    })

    expect(spawn).not.toHaveBeenCalled()
    expect(stdout.write).toHaveBeenCalledWith('\x07')
  })

  it('uses click-aware native notifications to present the originating Ghostty surface', () => {
    const stdout = fakeStdout()
    const { child, handlers, stdoutHandlers } = fakeChild()
    const spawn = vi.fn(() => child)

    sendApprovalNotification({
      description: 'Approval needed',
      env: {
        GHOSTTY_BIN_DIR: '/home/volt/.local/opt/ghostty-tip/bin',
        GHOSTTY_SURFACE_ID: '0x016ffcc51bed19c1',
        WAYLAND_DISPLAY: 'wayland-1'
      },
      iconPath: '/repo/website/static/img/logo.png',
      method: 'native',
      platform: 'linux',
      spawn,
      stdout: stdout as any
    })

    expect(spawn).toHaveBeenNthCalledWith(
      1,
      'notify-send',
      [
        '--app-name=Hermes',
        '--icon=/repo/website/static/img/logo.png',
        '--transient',
        '--action=default=Open',
        '--wait',
        '⚠ Attention Required',
        'Approval needed'
      ],
      { detached: true, stdio: ['ignore', 'pipe', 'ignore'] }
    )

    stdoutHandlers.data?.('default\n')
    handlers.close?.(0)

    expect(spawn).toHaveBeenNthCalledWith(
      2,
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
        '[<uint64 0x016ffcc51bed19c1>]',
        '{}'
      ],
      { detached: true, stdio: 'ignore' }
    )
    expect(child.stdout.unref).toHaveBeenCalled()
    expect(stdout.write).not.toHaveBeenCalled()
  })
})
