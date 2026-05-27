import { describe, expect, it } from 'vitest'

import { needsAltScreenResizeScrollbackClear, shouldUseDecstbmScrollOptimization } from './terminal.js'

describe('terminal resize quirks', () => {
  it('uses a deeper alt-screen resize clear for Apple Terminal', () => {
    expect(needsAltScreenResizeScrollbackClear({ TERM_PROGRAM: 'Apple_Terminal' })).toBe(true)
    expect(needsAltScreenResizeScrollbackClear({ TERM_PROGRAM: ' Apple_Terminal ' })).toBe(true)
  })

  it('keeps the normal resize repaint path for modern terminals', () => {
    expect(needsAltScreenResizeScrollbackClear({ TERM_PROGRAM: 'vscode' })).toBe(false)
    expect(needsAltScreenResizeScrollbackClear({ TERM_PROGRAM: 'iTerm.app' })).toBe(false)
  })
})

describe('DECSTBM scroll optimization', () => {
  it('uses the fast path on synchronized non-Ghostty terminals', () => {
    expect(shouldUseDecstbmScrollOptimization({ TERM_PROGRAM: 'WezTerm' }, true)).toBe(true)
  })

  it('falls back to repainting shifted rows in Ghostty', () => {
    expect(shouldUseDecstbmScrollOptimization({ TERM_PROGRAM: 'ghostty' }, true)).toBe(false)
    expect(shouldUseDecstbmScrollOptimization({ TERM: 'xterm-ghostty' }, true)).toBe(false)
  })

  it('does not use the fast path without synchronized output support', () => {
    expect(shouldUseDecstbmScrollOptimization({ TERM_PROGRAM: 'WezTerm' }, false)).toBe(false)
  })

  it('allows a diagnostic environment override while still requiring synchronized output', () => {
    expect(shouldUseDecstbmScrollOptimization({ HERMES_TUI_DECSTBM: '1', TERM_PROGRAM: 'ghostty' }, true)).toBe(true)
    expect(shouldUseDecstbmScrollOptimization({ HERMES_TUI_DECSTBM: '0', TERM_PROGRAM: 'WezTerm' }, true)).toBe(false)
    expect(shouldUseDecstbmScrollOptimization({ HERMES_TUI_DECSTBM: '1', TERM_PROGRAM: 'ghostty' }, false)).toBe(false)
  })
})
