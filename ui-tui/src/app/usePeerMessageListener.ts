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

export function usePeerMessageListener({ appendMessage, lastUserMsgRef, sys }: Params): void {
  const stoppedRef = useRef(false)
  const wsRef = useRef<WebSocket | null>(null)
  // LRU of texts the user just submitted — when the bridge echoes our prompt
  // back as a user_message_chunk we suppress it.
  const recentSelfMessagesRef = useRef<string[]>([])

  useEffect(() => {
    const bridgeUrl = (process.env.HERMES_BRIDGE_URL ?? '').trim()
    if (!bridgeUrl) return

    stoppedRef.current = false

    // Keep recentSelfMessagesRef synced with lastUserMsgRef on every render
    // tick by polling. (lastUserMsg is updated synchronously when the user
    // submits — we just need to capture the value before the bridge echo
    // arrives, which is usually within ~50ms.)
    const syncInterval = setInterval(() => {
      const last = lastUserMsgRef.current?.trim() ?? ''
      if (!last) return
      const lru = recentSelfMessagesRef.current
      if (lru[lru.length - 1] !== last) {
        lru.push(last)
        if (lru.length > 32) lru.shift()
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
              const update = parsed.params?.update ?? {}
              const kind: string = update.sessionUpdate ?? ''
              const content = update.content
              let text = ''
              if (content && typeof content === 'object') {
                text = String(content.text ?? '').trim()
              }

              if (kind === 'user_message_chunk') {
                if (!text) return
                const lru = recentSelfMessagesRef.current
                const selfIdx = lru.lastIndexOf(text)
                if (selfIdx >= 0) {
                  lru.splice(selfIdx, 1) // consume the dedup token
                  return
                }
                appendMessage({
                  role: 'user',
                  text: `🌐 peer ▶ ${text}`
                } as Msg)
              } else if (kind === 'agent_message_chunk') {
                // Peer's agent turn — render as an assistant message tagged
                // as peer. We can't distinguish "my turn's agent" from
                // "peer's turn's agent" reliably here, so v0 always tags;
                // future work: track active_turn_bridge_id via a side-channel.
                if (!text) return
                appendMessage({
                  role: 'assistant',
                  text: `🌐 ${text}`
                } as Msg)
              } else if (kind === 'tool_call') {
                const name = update.title ?? update.name ?? 'tool'
                appendMessage({
                  role: 'tool',
                  text: `🌐 🔧 ${name}`
                } as Msg)
              }
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
