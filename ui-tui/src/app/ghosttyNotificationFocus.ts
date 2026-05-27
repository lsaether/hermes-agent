export type GhosttyNotificationEnv = NodeJS.ProcessEnv | Record<string, string | undefined>

export type GhosttyFocusTarget = {
  destination: string
  objectPath: string
  surfaceId: string
}

export type GhosttyFocusChildLike = {
  unref?: () => void
}

export type GhosttyFocusSpawnLike = (
  command: string,
  args: string[],
  options: { detached: boolean; stdio: 'ignore' }
) => GhosttyFocusChildLike

const DEFAULT_GHOSTTY_APP_ID = 'com.mitchellh.ghostty'
const GHOSTTY_TIP_APP_ID = 'com.mitchellh.ghostty.tip'
const UINT64_MAX = (1n << 64n) - 1n

const DISABLED_VALUES = new Set(['0', 'false', 'no', 'off', 'disabled'])
const DBUS_APP_ID_RE = /^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)+$/
const DBUS_OBJECT_PATH_RE = /^\/(?:[A-Za-z_][A-Za-z0-9_]*)(?:\/[A-Za-z_][A-Za-z0-9_]*)*$/

const isDisabled = (raw: string | undefined) => Boolean(raw && DISABLED_VALUES.has(raw.trim().toLowerCase()))

const normalizeSurfaceId = (raw: string | undefined) => {
  const value = raw?.trim()

  if (!value) {
    return null
  }

  const valid = /^0x[0-9a-f]+$/i.test(value) || /^[0-9]+$/.test(value)

  if (!valid) {
    return null
  }

  try {
    const parsed = BigInt(value)

    if (parsed <= 0n || parsed > UINT64_MAX) {
      return null
    }

    return value
  } catch {
    return null
  }
}

const objectPathFromAppId = (appId: string) => `/${appId.replace(/\./g, '/')}`

const validAppId = (value: string | undefined) => {
  const trimmed = value?.trim()

  return trimmed && DBUS_APP_ID_RE.test(trimmed) ? trimmed : null
}

const validObjectPath = (value: string | undefined) => {
  const trimmed = value?.trim()

  return trimmed && DBUS_OBJECT_PATH_RE.test(trimmed) ? trimmed : null
}

const envContainsGhosttyTipPath = (env: GhosttyNotificationEnv) =>
  [env.GHOSTTY_BIN_DIR, env.GHOSTTY_RESOURCES_DIR, env.TERMINFO]
    .filter(Boolean)
    .some(value => /(?:^|[/_-])ghostty-tip(?:$|[/_-])/.test(String(value)))

const resolveGhosttyAppId = (env: GhosttyNotificationEnv) => {
  const explicitDestination = validAppId(env.HERMES_GHOSTTY_DBUS_DEST)

  if (explicitDestination) {
    return explicitDestination
  }

  const explicitAppId = validAppId(env.HERMES_GHOSTTY_APP_ID)

  if (explicitAppId) {
    return explicitAppId
  }

  if (envContainsGhosttyTipPath(env)) {
    return GHOSTTY_TIP_APP_ID
  }

  return DEFAULT_GHOSTTY_APP_ID
}

export const resolveGhosttyFocusTarget = (env: GhosttyNotificationEnv = process.env): GhosttyFocusTarget | null => {
  if (isDisabled(env.HERMES_GHOSTTY_NOTIFICATION_FOCUS)) {
    return null
  }

  const surfaceId = normalizeSurfaceId(env.GHOSTTY_SURFACE_ID)

  if (!surfaceId) {
    return null
  }

  const destination = resolveGhosttyAppId(env)
  const objectPath = validObjectPath(env.HERMES_GHOSTTY_DBUS_OBJECT_PATH) ?? objectPathFromAppId(destination)

  return { destination, objectPath, surfaceId }
}

export const buildGhosttyPresentSurfaceArgs = ({ destination, objectPath, surfaceId }: GhosttyFocusTarget) => [
  'call',
  '--session',
  '--dest',
  destination,
  '--object-path',
  objectPath,
  '--method',
  'org.gtk.Actions.Activate',
  'present-surface',
  `[<uint64 ${surfaceId}>]`,
  '{}'
]

export const notificationActionShouldFocusGhostty = (output: string) => {
  const action = output.trim()

  return action === 'default' || action === 'open'
}

export const spawnGhosttyPresentSurface = (target: GhosttyFocusTarget, spawn: GhosttyFocusSpawnLike) => {
  try {
    const child = spawn('gdbus', buildGhosttyPresentSurfaceArgs(target), { detached: true, stdio: 'ignore' })
    child.unref?.()
  } catch {
    // Click-to-focus is opportunistic: notification delivery should not fail if
    // gdbus is missing or Ghostty rejects the surface id.
  }
}
