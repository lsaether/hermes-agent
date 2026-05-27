import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { stripAnsi } from '../lib/text.js'

import {
  type GhosttyFocusTarget,
  notificationActionShouldFocusGhostty,
  resolveGhosttyFocusTarget,
  spawnGhosttyPresentSurface
} from './ghosttyNotificationFocus.js'

export type TuiNotificationMethod = 'auto' | 'bel' | 'native' | 'osc9'

export const DEFAULT_TUI_NOTIFICATION_METHOD: TuiNotificationMethod = 'auto'
export const TUI_NOTIFICATION_BODY_MAX = 240
export const TUI_NOTIFICATION_TITLE_MAX = 80

const OSC9_TERMINAL_HINTS = ['ghostty', 'iterm', 'kitty', 'wezterm', 'warp']
const moduleDir = dirname(fileURLToPath(import.meta.url))
const HERMES_SELF_AVATAR_RELATIVE_PATH = 'assets/hermes-self-avatar.jpeg'

const HERMES_NOTIFICATION_ICON_CANDIDATES = [
  '../../../website/static/img/logo.png',
  '../../website/static/img/logo.png'
] as const

type NotificationEnv = NodeJS.ProcessEnv | Record<string, string | undefined>

export type ChildLike = {
  once?: (event: string, cb: (...args: any[]) => void) => ChildLike
  stdout?: {
    on?: (event: string, cb: (...args: any[]) => void) => unknown
    setEncoding?: (encoding: BufferEncoding) => unknown
    unref?: () => void
  } | null
  unref?: () => void
}

export type SpawnLike = (
  command: string,
  args: string[],
  options: { detached: boolean; stdio: 'ignore' | ['ignore', 'pipe', 'ignore'] }
) => ChildLike

export interface TuiNotificationOptions {
  body?: string
  env?: NotificationEnv
  iconPath?: string
  method?: TuiNotificationMethod
  nativeBodyFallback?: string
  platform?: NodeJS.Platform | string
  spawn?: SpawnLike
  stdout?: NodeJS.WriteStream
  terminalMessage?: string
  title: string
}

const resolveHermesHome = (env: NotificationEnv = process.env, fallbackHome = homedir()) => {
  const configuredHome = env.HERMES_HOME?.trim()

  return configuredHome ? resolve(configuredHome) : resolve(fallbackHome, '.hermes')
}

export const resolveHermesNotificationIcon = (
  baseDir = moduleDir,
  fileExists: (path: string) => boolean = existsSync,
  env: NotificationEnv = process.env,
  fallbackHome = homedir()
) => {
  const selfAvatar = resolve(resolveHermesHome(env, fallbackHome), HERMES_SELF_AVATAR_RELATIVE_PATH)

  if (fileExists(selfAvatar)) {
    return selfAvatar
  }

  for (const relativePath of HERMES_NOTIFICATION_ICON_CANDIDATES) {
    const candidate = resolve(baseDir, relativePath)

    if (fileExists(candidate)) {
      return candidate
    }
  }

  return resolve(baseDir, HERMES_NOTIFICATION_ICON_CANDIDATES[0])
}

export const DEFAULT_HERMES_NOTIFICATION_ICON = resolveHermesNotificationIcon()

export const normalizeTuiNotificationMethod = (raw: unknown): TuiNotificationMethod => {
  if (typeof raw !== 'string') {
    return DEFAULT_TUI_NOTIFICATION_METHOD
  }

  const value = raw.trim().toLowerCase()

  return value === 'auto' || value === 'bel' || value === 'native' || value === 'osc9'
    ? value
    : DEFAULT_TUI_NOTIFICATION_METHOD
}

const NON_ANSI_CONTROL_RE = /[\x00-\x09\x0b-\x1a\x1c-\x1f\x7f]/g

const preserveControlSeparators = (message: string) => message.replace(NON_ANSI_CONTROL_RE, ' ')

export const stripNotificationControls = (message: string) =>
  message.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim()

export const stripNotificationLineControls = (message: string) =>
  message.replace(/[\x00-\x09\x0b-\x1f\x7f]/g, ' ').replace(/[ \t]+/g, ' ').trim()

export const notificationPlainText = (raw: string | undefined) =>
  stripNotificationControls(stripAnsi(preserveControlSeparators(raw ?? '')))

export const notificationLineText = (raw: string | undefined) =>
  stripNotificationLineControls(stripAnsi(preserveControlSeparators(raw ?? '')))

export const truncateNotificationText = (text: string, maxLength: number) =>
  text.length > maxLength ? `${text.slice(0, maxLength - 1).trimEnd()}…` : text

export const notificationSingleLine = (raw: string | undefined, maxLength = TUI_NOTIFICATION_BODY_MAX) => {
  const text = notificationPlainText(raw)

  return text ? truncateNotificationText(text, maxLength) : ''
}

const supportsOsc9Notifications = (env: NotificationEnv | undefined) => {
  const termProgram = (env?.TERM_PROGRAM ?? '').toLowerCase()
  const term = (env?.TERM ?? '').toLowerCase()

  return OSC9_TERMINAL_HINTS.some(hint => termProgram.includes(hint) || term.includes(hint))
}

const supportsNativeNotifications = (env: NotificationEnv | undefined, platform: string) =>
  platform === 'linux' && Boolean(env?.WAYLAND_DISPLAY || env?.DISPLAY || env?.DBUS_SESSION_BUS_ADDRESS)

const tmuxPassthrough = (sequence: string) => `\x1bPtmux;${sequence.replace(/\x1b/g, '\x1b\x1b')}\x1b\\`

const writeTerminalNotification = (
  stdout: NodeJS.WriteStream,
  terminalMessage: string,
  method: TuiNotificationMethod,
  env: NotificationEnv | undefined
) => {
  if (method === 'bel' || (method === 'auto' && !supportsOsc9Notifications(env))) {
    stdout.write('\x07')

    return
  }

  const sequence = `\x1b]9;${terminalMessage}\x07`
  stdout.write(env?.TMUX ? tmuxPassthrough(sequence) : sequence)
}

const sendNativeNotification = (
  opts: {
    body: string
    ghosttyFocusTarget: GhosttyFocusTarget | null
    iconPath: string
    spawn: SpawnLike
    title: string
  },
  fallback: () => void
) => {
  let settled = false
  let actionOutput = ''
  const fallbackOnce = () => {
    if (settled) {
      return
    }

    settled = true
    fallback()
  }

  const args = ['--app-name=Hermes', `--icon=${opts.iconPath}`, '--transient']
  const stdio: 'ignore' | ['ignore', 'pipe', 'ignore'] = opts.ghosttyFocusTarget
    ? ['ignore', 'pipe', 'ignore']
    : 'ignore'

  if (opts.ghosttyFocusTarget) {
    args.push('--action=default=Open', '--wait')
  }

  args.push(opts.title, opts.body)

  try {
    const child = opts.spawn('notify-send', args, { detached: true, stdio })

    if (opts.ghosttyFocusTarget && child.stdout) {
      child.stdout.setEncoding?.('utf8')
      child.stdout.on?.('data', chunk => {
        actionOutput += String(chunk)
      })
      child.stdout.unref?.()
    }

    child.once?.('error', fallbackOnce)
    child.once?.('close', (code?: number) => {
      if (code !== 0) {
        fallbackOnce()
        return
      }

      if (opts.ghosttyFocusTarget && notificationActionShouldFocusGhostty(actionOutput)) {
        spawnGhosttyPresentSurface(opts.ghosttyFocusTarget, opts.spawn)
      }
    })
    child.unref?.()
  } catch {
    fallbackOnce()
  }
}

export const sendTuiNotification = ({
  body,
  env = process.env,
  iconPath = DEFAULT_HERMES_NOTIFICATION_ICON,
  method = DEFAULT_TUI_NOTIFICATION_METHOD,
  nativeBodyFallback = 'Notification',
  platform = process.platform,
  spawn = nodeSpawn as SpawnLike,
  stdout,
  terminalMessage,
  title
}: TuiNotificationOptions) => {
  if (!stdout?.isTTY) {
    return
  }

  const normalizedMethod = normalizeTuiNotificationMethod(method)
  const resolvedBody = body || nativeBodyFallback
  const resolvedTerminalMessage = terminalMessage || (body ? `${title}: ${body}` : title)
  const fallback = () => writeTerminalNotification(stdout, resolvedTerminalMessage, 'auto', env)
  const shouldUseNative =
    normalizedMethod === 'native' ||
    (normalizedMethod === 'auto' && supportsNativeNotifications(env, String(platform)))

  if (shouldUseNative) {
    sendNativeNotification({ body: resolvedBody, ghosttyFocusTarget: resolveGhosttyFocusTarget(env), iconPath, spawn, title }, fallback)

    return
  }

  writeTerminalNotification(stdout, resolvedTerminalMessage, normalizedMethod, env)
}
