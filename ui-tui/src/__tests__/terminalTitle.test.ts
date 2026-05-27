import { describe, expect, it } from 'vitest'

import { buildTerminalTitle, normalizeTabTitle } from '../app/terminalTitle.js'

describe('terminal tab title', () => {
  it('keeps the current model-based title when no custom tab title is configured', () => {
    expect(buildTerminalTitle({ marker: '✓', model: 'openai/gpt-5.5' })).toBe('✓ gpt-5.5')
  })

  it('uses a custom tab title instead of the model while preserving the status marker', () => {
    expect(buildTerminalTitle({ marker: '⏳', model: 'openai/gpt-5.5', tabTitle: 'Research' })).toBe('⏳ Research')
  })

  it('uses the durable session title before the legacy custom tab title', () => {
    expect(
      buildTerminalTitle({ marker: '✓', model: 'openai/gpt-5.5', sessionTitle: 'Durable Title', tabTitle: 'Legacy Tab' })
    ).toBe('✓ Durable Title')
  })

  it('keeps an explicit startup title above session and legacy tab titles', () => {
    expect(
      buildTerminalTitle({
        marker: '✓',
        model: 'openai/gpt-5.5',
        sessionTitle: 'Durable Title',
        startupTitle: 'Launch Label',
        tabTitle: 'Legacy Tab'
      })
    ).toBe('✓ Launch Label')
  })

  it('keeps the cwd suffix with custom tab titles', () => {
    expect(buildTerminalTitle({ cwd: '/home/volt/Code/hermes-agent', marker: '⚠', tabTitle: 'Hermes Dev' })).toBe(
      '⚠ Hermes Dev · ~/Code/hermes-agent'
    )
  })

  it('preserves the startup fallback before session info is available', () => {
    expect(buildTerminalTitle({ marker: '✓' })).toBe('Hermes')
  })

  it('normalizes non-string or blank custom tab titles to empty', () => {
    expect(normalizeTabTitle('  Hermes Focus  ')).toBe('Hermes Focus')
    expect(normalizeTabTitle('   ')).toBe('')
    expect(normalizeTabTitle(42)).toBe('')
  })
})
