/**
 * usePeerMessageListener — opens a persistent WebSocket to a hermes-bridge
 * endpoint (HERMES_BRIDGE_URL) and pumps incoming session/update events
 * into the chat transcript so peer subscribers (phone, acp-tui, Toad, etc.)
 * show up live in the Hermes Ink TUI.
 *
 * No-op when HERMES_BRIDGE_URL is unset, so it's safe to mount unconditionally.
 *
 * Architecture: this hook owns a separate WS connection from whatever the
 * `gatewayClient` uses for the per-turn agent backend. The bridge sees us as
 * a second subscriber on the same `?session=<id>` and broadcasts every other
 * subscriber's user_message_chunk / agent_message_chunk / tool_call events
 * to us. We dedup our OWN outgoing prompts (the bridge echoes them back as
 * user_message_chunks too) against a small LRU of recently-sent text.
 */
import { useEffect, useRef } from 'react'
import { estimateTokensRough } from '../lib/text.js'
import type { Msg } from '../types.js'

interface Params {
  appendMessage: (msg: Msg) => void
  /** Ref to the user's most recently-submitted prompt text (for dedup). */
  lastUserMsgRef: React.MutableRefObject<string>
  /** Optional system-message printer for diagnostic noise. */
  sys?: (text: string) => void
}

const HANDSHAKE_TIMEOUT_MS = 10_000
const RECONNECT_DELAY_MS = 2_000

// Idle window after the last peer event before we flush the accumulated
// peer turn as a single structured rendering. Long enough that a streaming
// agent's natural pauses don't cause premature flushes; short enough that
// completed turns appear promptly.
const PEER_TURN_IDLE_MS = 1500
// When the user submits in this TUI, suppress all bridge fan-out events for
// this many ms of quiet, so the agent's tool calls / responses for OUR turn
// don't render as peer activity. The bridge can't tell us "this event
// belongs to that subscriber's turn" — best we can do is mute around our
// own submission window.
const OWN_TURN_IDLE_MS = 3000

interface PeerTurnAccumulator {
  prompt: string
  thinking: string
  response: string
  tools: string[]
  active: boolean
}

const emptyPeerTurn = (): PeerTurnAccumulator => ({
  prompt: '',
  thinking: '',
  response: '',
  tools: [],
  active: false
})

export function usePeerMessageListener({ appendMessage, lastUserMsgRef, sys }: Params): void {
  const stoppedRef = useRef(false)
  const wsRef = useRef<WebSocket | null>(null)
  // LRU of texts the user just submitted — when the bridge echoes our prompt
  // back as a user_message_chunk we suppress it.
  const recentSelfMessagesRef = useRef<string[]>([])
  // Accumulator for a single peer turn — collects prompt, thinking, tools,
  // and final response, then emits a structured native-style rendering
  // (one role:'user' line + one kind:'trail' tree + one final response line)
  // on idle, matching what the native turn renderer produces.
  const peerTurnRef = useRef<PeerTurnAccumulator>(emptyPeerTurn())
  const peerTurnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Own-turn muting: set when we see a fresh local submission, cleared after
  // OWN_TURN_IDLE_MS of bridge silence. All session/update events arriving
  // during this window are dropped — they're either our prompt's echo or
  // the agent's response/tool activity for OUR turn.
  const ownTurnActiveRef = useRef(false)
  const ownTurnIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const bridgeUrl = (process.env.HERMES_BRIDGE_URL ?? '').trim()
    if (!bridgeUrl) return

    stoppedRef.current = false

    const refreshOwnTurnIdle = () => {
      if (ownTurnIdleTimerRef.current) clearTimeout(ownTurnIdleTimerRef.current)
      ownTurnIdleTimerRef.current = setTimeout(() => {
        ownTurnActiveRef.current = false
        ownTurnIdleTimerRef.current = null
      }, OWN_TURN_IDLE_MS)
    }
    const enterOwnTurn = () => {
      ownTurnActiveRef.current = true
      // Discard any in-flight peer turn — almost certainly stale.
      peerTurnRef.current = emptyPeerTurn()
      if (peerTurnTimerRef.current) {
        clearTimeout(peerTurnTimerRef.current)
        peerTurnTimerRef.current = null
      }
      refreshOwnTurnIdle()
    }

    const flushPeerTurn = () => {
      if (peerTurnTimerRef.current) {
        clearTimeout(peerTurnTimerRef.current)
        peerTurnTimerRef.current = null
      }
      const turn = peerTurnRef.current
      if (!turn.active) return
      peerTurnRef.current = emptyPeerTurn()

      // 1. Peer prompt — emitted as a system line with a peer marker (the
      //    Ink TUI's role:'user' would use the local user glyph and be
      //    visually indistinguishable from your own input).
      if (turn.prompt) {
        appendMessage({
          role: 'system',
          text: `🌐 peer: ${turn.prompt}`
        } as Msg)
      }

      // 2. Native-style trail Msg with thinking + tool list. The Ink TUI's
      //    ToolTrail component renders this as the collapsible `└─ ▾
      //    Thinking ~N tokens` / `└─ ▾ Tool calls (N)` tree.
      const thinkingText = turn.thinking.trim()
      if (thinkingText || turn.tools.length > 0) {
        const trail: Partial<Msg> & { kind: 'trail'; role: 'system'; text: string } = {
          kind: 'trail',
          role: 'system',
          text: ''
        }
        if (thinkingText) {
          trail.thinking = thinkingText
          trail.thinkingTokens = estimateTokensRough(thinkingText)
        }
        if (turn.tools.length) {
          trail.tools = turn.tools
        }
        appendMessage(trail as Msg)
      }

      // 3. Final agent response — dim system line with peer marker.
      const responseText = turn.response.trim()
      if (responseText) {
        appendMessage({
          role: 'system',
          text: `🌐    ${responseText}`
        } as Msg)
      }
    }

    const schedulePeerTurnFlush = () => {
      if (peerTurnTimerRef.current) clearTimeout(peerTurnTimerRef.current)
      peerTurnTimerRef.current = setTimeout(flushPeerTurn, PEER_TURN_IDLE_MS)
    }

    // Keep recentSelfMessagesRef synced with lastUserMsgRef on every render
    // tick by polling. When a new submission appears we ALSO enter own-turn
    // mute, so subsequent agent activity (tool calls, response chunks) gets
    // silenced as our own turn.
    const syncInterval = setInterval(() => {
      const last = lastUserMsgRef.current?.trim() ?? ''
      if (!last) return
      const lru = recentSelfMessagesRef.current
      if (lru[lru.length - 1] !== last) {
        lru.push(last)
        if (lru.length > 32) lru.shift()
        enterOwnTurn()
      }
    }, 100)

    let nextJsonRpcId = 1

    async function connectAndPump(): Promise<void> {
      while (!stoppedRef.current) {
        try {
          const ws = new WebSocket(bridgeUrl)
          wsRef.current = ws

          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error('handshake timeout')),
              HANDSHAKE_TIMEOUT_MS
            )
            ws.addEventListener('open', () => {
              clearTimeout(timer)
              resolve()
            }, { once: true })
            ws.addEventListener('error', () => {
              clearTimeout(timer)
              reject(new Error('socket error'))
            }, { once: true })
          })

          // initialize
          const initId = nextJsonRpcId++
          ws.send(
            JSON.stringify({
              jsonrpc: '2.0',
              id: initId,
              method: 'initialize',
              params: {
                protocolVersion: 1,
                clientInfo: { name: 'hermes-ink-peer-listener', version: '0.1.0' },
                clientCapabilities: {}
              }
            })
          )

          // session/new (bridge will intercept and return cached sessionId
          // matching the per-turn shim's session, so we attach to the same
          // ACP session)
          const newSessionId = nextJsonRpcId++
          ws.send(
            JSON.stringify({
              jsonrpc: '2.0',
              id: newSessionId,
              method: 'session/new',
              params: { cwd: process.cwd(), mcpServers: [] }
            })
          )

          // Now read frames forever; drop responses to our handshake ids,
          // route all session/update notifications into the transcript.
          await new Promise<void>((resolve, reject) => {
            ws.addEventListener('message', (ev) => {
              if (stoppedRef.current) return
              let raw: string
              if (typeof ev.data === 'string') {
                raw = ev.data
              } else {
                try {
                  raw = ev.data.toString('utf-8')
                } catch {
                  return
                }
              }
              let parsed: any
              try {
                parsed = JSON.parse(raw)
              } catch {
                return
              }
              if (!parsed || typeof parsed !== 'object') return

              // Handshake replies — drop.
              if (typeof parsed.id !== 'undefined') {
                if (parsed.method && parsed.id != null) {
                  // Agent-initiated request — respond with -32601 so the
                  // agent doesn't stall. The per-turn shim handles real
                  // tool authorization for our own outgoing turns.
                  try {
                    ws.send(
                      JSON.stringify({
                        jsonrpc: '2.0',
                        id: parsed.id,
                        error: {
                          code: -32601,
                          message:
                            'ink peer listener does not handle agent-initiated requests'
                        }
                      })
                    )
                  } catch {
                    /* socket closed */
                  }
                }
                return
              }

              if (parsed.method !== 'session/update') return

              // Own-turn mute: if a local submission was just made, every
              // event flowing through the bridge during the silence window
              // is almost certainly OUR turn's activity (the bundled-prompt
              // echo, the agent's tool calls, the response chunks). Drop
              // them all; the local TUI is already rendering them natively
              // through its own gateway client.
              if (ownTurnActiveRef.current) {
                refreshOwnTurnIdle()
                return
              }

              const update = parsed.params?.update ?? {}
              const kind: string = update.sessionUpdate ?? ''
              const content = update.content
              let text = ''
              if (content && typeof content === 'object') {
                text = String(content.text ?? '').trim()
              }

              if (kind === 'user_message_chunk') {
                if (!text) return
                // Echo detection: the patch's _format_messages_as_prompt
                // bundles the whole conversation transcript before calling
                // session/prompt, so the bridge's echo of our own outgoing
                // prompt is a multi-line bundle ending with "User:\n<input>".
                // Match by suffix to catch both shapes.
                const lru = recentSelfMessagesRef.current
                let matchedIdx = -1
                for (let i = lru.length - 1; i >= 0; i--) {
                  const own = lru[i]
                  if (!own) continue
                  if (
                    text === own ||
                    text.endsWith(own) ||
                    text.endsWith(`User:\n${own}`) ||
                    text.endsWith(`User: ${own}`)
                  ) {
                    matchedIdx = i
                    break
                  }
                }
                if (matchedIdx >= 0) {
                  lru.splice(matchedIdx, 1) // consume the dedup token
                  return
                }
                // A new peer turn starts. Flush any previous turn that's
                // still buffered (e.g. quick back-to-back peer messages
                // wouldn't otherwise show until the idle timer).
                flushPeerTurn()
                // Trim bundled transcripts down to the last User:\n entry
                // (covers the case where another Hermes-TUI peer also sends
                // its conversation bundle).
                let display = text
                const lastUserIdx = display.lastIndexOf('User:\n')
                if (lastUserIdx >= 0) {
                  display = display.slice(lastUserIdx + 'User:\n'.length).trim()
                }
                peerTurnRef.current = {
                  prompt: display,
                  thinking: '',
                  response: '',
                  tools: [],
                  active: true
                }
                schedulePeerTurnFlush()
              } else if (kind === 'agent_thought_chunk') {
                if (!text) return
                peerTurnRef.current.thinking += text
                peerTurnRef.current.active = true
                schedulePeerTurnFlush()
              } else if (kind === 'agent_message_chunk') {
                if (!text) return
                peerTurnRef.current.response += text
                peerTurnRef.current.active = true
                schedulePeerTurnFlush()
              } else if (kind === 'tool_call') {
                const name = update.title ?? update.name ?? 'tool'
                peerTurnRef.current.tools.push(String(name))
                peerTurnRef.current.active = true
                schedulePeerTurnFlush()
              }
              // tool_call_update: native renderer doesn't show per-update
              // output in the tree (it counts tool tokens via a side
              // channel). Skip for now — the trail shows tool NAMES, which
              // is the level of detail the native UI uses.
              // plan kind: also hidden in v0.
            })

            ws.addEventListener('close', () => resolve())
            ws.addEventListener('error', () => reject(new Error('socket error mid-stream')))
          })
        } catch (err) {
          if (stoppedRef.current) return
          if (sys) {
            try {
              sys(`peer listener: ${(err as Error).message ?? err}; reconnecting in ${RECONNECT_DELAY_MS}ms`)
            } catch {
              /* ignore */
            }
          }
          await new Promise((r) => setTimeout(r, RECONNECT_DELAY_MS))
        }
      }
    }

    void connectAndPump()

    return () => {
      stoppedRef.current = true
      clearInterval(syncInterval)
      if (peerTurnTimerRef.current) {
        clearTimeout(peerTurnTimerRef.current)
        peerTurnTimerRef.current = null
      }
      if (ownTurnIdleTimerRef.current) {
        clearTimeout(ownTurnIdleTimerRef.current)
        ownTurnIdleTimerRef.current = null
      }
      // Drop any in-flight peer turn — app is going down.
      peerTurnRef.current = emptyPeerTurn()
      const ws = wsRef.current
      if (ws && ws.readyState !== ws.CLOSED) {
        try {
          ws.close()
        } catch {
          /* ignore */
        }
      }
    }
  }, [appendMessage, lastUserMsgRef, sys])
}
