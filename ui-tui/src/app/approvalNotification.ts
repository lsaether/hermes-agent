import {
  DEFAULT_HERMES_NOTIFICATION_ICON,
  DEFAULT_TUI_NOTIFICATION_METHOD,
  notificationSingleLine,
  sendTuiNotification,
  type SpawnLike,
  type TuiNotificationMethod
} from './tuiNotification.js'

export type ApprovalNotificationMethod = TuiNotificationMethod

export const APPROVAL_NOTIFICATION_TITLE = '⚠ Attention Required'
export const DEFAULT_APPROVAL_NOTIFICATION_METHOD: ApprovalNotificationMethod = DEFAULT_TUI_NOTIFICATION_METHOD

const APPROVAL_NOTIFICATION_DEFAULT_DESCRIPTION = 'dangerous command'
const APPROVAL_NOTIFICATION_NATIVE_FALLBACK = 'Approval needed'

export interface ApprovalNotificationOptions {
  description?: string
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>
  iconPath?: string
  method?: ApprovalNotificationMethod
  platform?: NodeJS.Platform | string
  spawn?: SpawnLike
  stdout?: NodeJS.WriteStream
}

export const approvalNotificationBody = (description?: string) =>
  notificationSingleLine(description || APPROVAL_NOTIFICATION_DEFAULT_DESCRIPTION)

export const approvalTerminalMessage = (description?: string) => {
  const body = approvalNotificationBody(description)

  return body ? `${APPROVAL_NOTIFICATION_TITLE}: ${body}` : APPROVAL_NOTIFICATION_TITLE
}

export const sendApprovalNotification = ({
  description,
  env = process.env,
  iconPath = DEFAULT_HERMES_NOTIFICATION_ICON,
  method = DEFAULT_APPROVAL_NOTIFICATION_METHOD,
  platform = process.platform,
  spawn,
  stdout
}: ApprovalNotificationOptions) => {
  const body = approvalNotificationBody(description)

  sendTuiNotification({
    body,
    env,
    iconPath,
    method,
    nativeBodyFallback: APPROVAL_NOTIFICATION_NATIVE_FALLBACK,
    platform,
    spawn,
    stdout,
    terminalMessage: approvalTerminalMessage(description),
    title: APPROVAL_NOTIFICATION_TITLE
  })
}
