import { describe, expect, it, vi } from 'vitest'

import { resolveHermesNotificationIcon, sendCompletionNotification } from '../app/completionNotification.js'

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

describe('completion notifications', () => {
  it('prefers the saved Hermes self-avatar in HERMES_HOME when present', () => {
    const selfAvatar = '/hermes-home/assets/hermes-self-avatar.jpeg'
    const repoIcon = '/repo/website/static/img/logo.png'
    const exists = (path: string) => path === selfAvatar || path === repoIcon

    expect(resolveHermesNotificationIcon('/repo/ui-tui/src/app', exists, { HERMES_HOME: '/hermes-home' })).toBe(
      selfAvatar
    )
  })

  it('finds the saved Hermes self-avatar under ~/.hermes when HERMES_HOME is unset', () => {
    const selfAvatar = '/home/tester/.hermes/assets/hermes-self-avatar.jpeg'
    const exists = (path: string) => path === selfAvatar

    expect(resolveHermesNotificationIcon('/repo/ui-tui/src/app', exists, {}, '/home/tester')).toBe(selfAvatar)
  })

  it('resolves the Hermes icon from both source and bundled dist module locations', () => {
    const repoIcon = '/repo/website/static/img/logo.png'
    const exists = (path: string) => path === repoIcon

    expect(resolveHermesNotificationIcon('/repo/ui-tui/src/app', exists, {}, '/home/tester')).toBe(repoIcon)
    expect(resolveHermesNotificationIcon('/repo/ui-tui/dist', exists, {}, '/home/tester')).toBe(repoIcon)
  })

  it('uses notify-send with the Hermes icon in auto mode on Linux desktops', () => {
    const stdout = fakeStdout()
    const { child } = fakeChild()
    const spawn = vi.fn(() => child)

    sendCompletionNotification({
      env: { WAYLAND_DISPLAY: 'wayland-1' },
      iconPath: '/repo/website/static/img/logo.png',
      method: 'auto',
      outcomeText: 'native desktop toast',
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
        'Hermes',
        'native desktop toast'
      ],
      { detached: true, stdio: 'ignore' }
    )
    expect(child.unref).toHaveBeenCalled()
    expect(stdout.write).not.toHaveBeenCalled()
  })

  it('uses the tab title as the native notification title and keeps a short multiline body', () => {
    const stdout = fakeStdout()
    const { child } = fakeChild()
    const spawn = vi.fn(() => child)

    sendCompletionNotification({
      env: { WAYLAND_DISPLAY: 'wayland-1' },
      iconPath: '/repo/website/static/img/logo.png',
      method: 'native',
      notificationTitle: 'Research',
      outcomeText: 'First useful line\nSecond useful line\nThird line should be omitted',
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
        'Research',
        'First useful line\nSecond useful line'
      ],
      { detached: true, stdio: 'ignore' }
    )
  })

  it('marks stale busy tab titles as done in native notification titles', () => {
    const stdout = fakeStdout()
    const { child } = fakeChild()
    const spawn = vi.fn(() => child)

    sendCompletionNotification({
      env: { WAYLAND_DISPLAY: 'wayland-1' },
      iconPath: '/repo/website/static/img/logo.png',
      method: 'native',
      notificationTitle: '⏳ Research · hermes-agent',
      outcomeText: 'Done',
      platform: 'linux',
      spawn,
      stdout: stdout as any
    })

    expect(spawn).toHaveBeenCalledWith(
      'notify-send',
      expect.arrayContaining(['--transient', '✓ Research · hermes-agent', 'Done']),
      { detached: true, stdio: 'ignore' }
    )
  })

  it('uses notify-send on Hyprland sessions discovered via the DBus session bus', () => {
    const stdout = fakeStdout()
    const { child } = fakeChild()
    const spawn = vi.fn(() => child)

    sendCompletionNotification({
      env: {
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
        XDG_CURRENT_DESKTOP: 'Hyprland'
      },
      method: 'auto',
      outcomeText: 'hyprland desktop toast',
      platform: 'linux',
      spawn,
      stdout: stdout as any
    })

    expect(spawn).toHaveBeenCalledWith(
      'notify-send',
      expect.arrayContaining(['--app-name=Hermes', '--transient', 'Hermes', 'hyprland desktop toast']),
      { detached: true, stdio: 'ignore' }
    )
    expect(stdout.write).not.toHaveBeenCalled()
  })

  it('falls back to OSC 9 when notify-send cannot be spawned', () => {
    const stdout = fakeStdout()
    const { child, handlers } = fakeChild()
    const spawn = vi.fn(() => child)

    sendCompletionNotification({
      env: { TERM: 'xterm-ghostty', WAYLAND_DISPLAY: 'wayland-1' },
      iconPath: '/repo/website/static/img/logo.png',
      method: 'auto',
      outcomeText: 'fallback path',
      platform: 'linux',
      spawn,
      stdout: stdout as any
    })
    handlers.error?.(new Error('ENOENT'))

    expect(stdout.write).toHaveBeenCalledWith('\x1b]9;Hermes: fallback path\x07')
  })

  it('can force OSC 9 and skip native desktop notifications', () => {
    const stdout = fakeStdout()
    const { child } = fakeChild()
    const spawn = vi.fn(() => child)

    sendCompletionNotification({
      env: { TERM: 'xterm-ghostty', WAYLAND_DISPLAY: 'wayland-1' },
      method: 'osc9',
      outcomeText: 'terminal only',
      platform: 'linux',
      spawn,
      stdout: stdout as any
    })

    expect(spawn).not.toHaveBeenCalled()
    expect(stdout.write).toHaveBeenCalledWith('\x1b]9;Hermes: terminal only\x07')
  })

  it('prefixes terminal notifications with the tab title when provided', () => {
    const stdout = fakeStdout()
    const spawn = vi.fn()

    sendCompletionNotification({
      env: { TERM: 'xterm-ghostty' },
      method: 'osc9',
      notificationTitle: 'Code Review',
      outcomeText: 'terminal title body',
      platform: 'linux',
      spawn,
      stdout: stdout as any
    })

    expect(spawn).not.toHaveBeenCalled()
    expect(stdout.write).toHaveBeenCalledWith('\x1b]9;Code Review: terminal title body\x07')
  })

  it('marks stale busy tab titles as done in terminal notifications', () => {
    const stdout = fakeStdout()
    const spawn = vi.fn()

    sendCompletionNotification({
      env: { TERM: 'xterm-ghostty' },
      method: 'osc9',
      notificationTitle: '⏳ Code Review',
      outcomeText: 'terminal title body',
      platform: 'linux',
      spawn,
      stdout: stdout as any
    })

    expect(spawn).not.toHaveBeenCalled()
    expect(stdout.write).toHaveBeenCalledWith('\x1b]9;✓ Code Review: terminal title body\x07')
  })

  it('uses click-aware native notifications to present the originating Ghostty surface', () => {
    const stdout = fakeStdout()
    const { child, handlers, stdoutHandlers } = fakeChild()
    const spawn = vi.fn(() => child)

    sendCompletionNotification({
      env: {
        GHOSTTY_SURFACE_ID: '0xca6e0ea203737901',
        HERMES_GHOSTTY_APP_ID: 'com.mitchellh.ghostty.tip',
        WAYLAND_DISPLAY: 'wayland-1'
      },
      iconPath: '/repo/website/static/img/logo.png',
      method: 'native',
      notificationTitle: '⏳ Ghostty Notifs',
      outcomeText: 'Clickable success toast',
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
        '✓ Ghostty Notifs',
        'Clickable success toast'
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
        '[<uint64 0xca6e0ea203737901>]',
        '{}'
      ],
      { detached: true, stdio: 'ignore' }
    )
    expect(child.stdout.unref).toHaveBeenCalled()
    expect(stdout.write).not.toHaveBeenCalled()
  })
})
