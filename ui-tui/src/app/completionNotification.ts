import {
  DEFAULT_HERMES_NOTIFICATION_ICON,
  DEFAULT_TUI_NOTIFICATION_METHOD,
  TUI_NOTIFICATION_BODY_MAX,
  TUI_NOTIFICATION_TITLE_MAX,
  normalizeTuiNotificationMethod,
  notificationLineText,
  notificationPlainText,
  resolveHermesNotificationIcon,
  sendTuiNotification,
  truncateNotificationText,
  type SpawnLike,
  type TuiNotificationMethod
} from './tuiNotification.js'

export type CompletionNotificationMethod = TuiNotificationMethod

const COMPLETION_NOTIFICATION_FALLBACK = 'Hermes turn complete'
const COMPLETION_NOTIFICATION_NATIVE_FALLBACK = 'Turn complete'
const COMPLETION_NOTIFICATION_PREVIEW_MAX = 180
const COMPLETION_NOTIFICATION_BODY_LINES = 2
const COMPLETION_TITLE_DONE_MARKER = '✓'
const COMPLETION_TITLE_STATUS_MARKER_RE = /^[⏳⚠✓]\s+/

export const DEFAULT_COMPLETION_NOTIFICATION_METHOD: CompletionNotificationMethod = DEFAULT_TUI_NOTIFICATION_METHOD
export { DEFAULT_HERMES_NOTIFICATION_ICON, resolveHermesNotificationIcon }

export interface CompletionNotificationOptions {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>
  iconPath?: string
  method?: CompletionNotificationMethod
  notificationTitle?: string
  outcomeText?: string
  platform?: NodeJS.Platform | string
  spawn?: SpawnLike
  stdout?: NodeJS.WriteStream
}

export const normalizeCompletionNotificationMethod = normalizeTuiNotificationMethod

export const completionNotificationTitle = (raw?: string) => {
  const title = notificationPlainText(raw).replace(COMPLETION_TITLE_STATUS_MARKER_RE, `${COMPLETION_TITLE_DONE_MARKER} `)

  if (!title) {
    return 'Hermes'
  }

  return truncateNotificationText(title, TUI_NOTIFICATION_TITLE_MAX)
}

export const completionNotificationBody = (outcomeText?: string) => {
  const lines = (outcomeText ?? '')
    .split(/\r?\n/)
    .map(notificationLineText)
    .filter(Boolean)
    .slice(0, COMPLETION_NOTIFICATION_BODY_LINES)

  const body = lines.join('\n')

  return body ? truncateNotificationText(body, TUI_NOTIFICATION_BODY_MAX) : ''
}

export const completionNotificationPreview = (outcomeText?: string) => {
  const preview = notificationPlainText(outcomeText)

  return preview ? truncateNotificationText(preview, COMPLETION_NOTIFICATION_PREVIEW_MAX) : ''
}

export const completionTerminalMessage = (outcomeText?: string, notificationTitle?: string) => {
  const preview = completionNotificationPreview(outcomeText)
  const title = completionNotificationTitle(notificationTitle)

  if (preview) {
    return `${title}: ${preview}`
  }

  return title === 'Hermes' ? COMPLETION_NOTIFICATION_FALLBACK : `${title}: ${COMPLETION_NOTIFICATION_NATIVE_FALLBACK}`
}

export const sendCompletionNotification = ({
  env = process.env,
  iconPath = DEFAULT_HERMES_NOTIFICATION_ICON,
  method = DEFAULT_COMPLETION_NOTIFICATION_METHOD,
  notificationTitle,
  outcomeText,
  platform = process.platform,
  spawn,
  stdout
}: CompletionNotificationOptions) => {
  const title = completionNotificationTitle(notificationTitle)
  const body = completionNotificationBody(outcomeText)

  sendTuiNotification({
    body,
    env,
    iconPath,
    method,
    nativeBodyFallback: COMPLETION_NOTIFICATION_NATIVE_FALLBACK,
    platform,
    spawn,
    stdout,
    terminalMessage: completionTerminalMessage(outcomeText, notificationTitle),
    title
  })
}
