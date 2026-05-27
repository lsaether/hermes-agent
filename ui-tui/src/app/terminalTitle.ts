import { shortCwd } from '../domain/paths.js'

const TAB_TITLE_MAX = 80

export interface TerminalTitleOptions {
  cwd?: string
  marker: string
  model?: string
  sessionTitle?: unknown
  startupTitle?: unknown
  tabTitle?: unknown
}

export const normalizeTabTitle = (raw: unknown): string => {
  if (typeof raw !== 'string') {
    return ''
  }

  const cleaned = raw.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim()

  return cleaned.length > TAB_TITLE_MAX ? `${cleaned.slice(0, TAB_TITLE_MAX - 1).trimEnd()}…` : cleaned
}

const modelTitle = (model?: string) => (model ?? '').replace(/^.*\//, '').trim()

export const buildTerminalTitle = ({
  cwd,
  marker,
  model,
  sessionTitle,
  startupTitle,
  tabTitle
}: TerminalTitleOptions): string => {
  const base = normalizeTabTitle(startupTitle) || normalizeTabTitle(sessionTitle) || normalizeTabTitle(tabTitle) || modelTitle(model)

  if (!base) {
    return 'Hermes'
  }

  return `${marker} ${base}${cwd ? ` · ${shortCwd(cwd, 24)}` : ''}`
}
