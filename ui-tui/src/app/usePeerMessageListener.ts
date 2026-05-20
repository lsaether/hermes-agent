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

const PEER_AGENT_FLUSH_MS = 600

export function usePeerMessageListener({ appendMessage, lastUserMsgRef, sys }: Params): void {
  const stoppedRef = useRef(false)
  const wsRef = useRef<WebSocket | null>(null)
  // LRU of texts the user just submitted — when the bridge echoes our prompt
  // back as a user_message_chunk we suppress it.
  const recentSelfMessagesRef = useRef<string[]>([])
  // Buffer for token-level agent_message_chunk streams; flushed on a debounce
  // timer so the transcript gets one coalesced line per agent burst instead
  // of one system line per token.
  const peerAgentBufRef = useRef<string>('')
  const peerAgentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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

              const flushPeerAgentBuf = () => {
                if (peerAgentTimerRef.current) {
                  clearTimeout(peerAgentTimerRef.current)
                  peerAgentTimerRef.current = null
                }
                const buffered = peerAgentBufRef.current.trim()
                peerAgentBufRef.current = ''
                if (buffered) {
                  appendMessage({
                    role: 'system',
                    text: `🌐   ${buffered}`
                  } as Msg)
                }
              }
              const schedulePeerAgentFlush = () => {
                if (peerAgentTimerRef.current) clearTimeout(peerAgentTimerRef.current)
                peerAgentTimerRef.current = setTimeout(flushPeerAgentBuf, PEER_AGENT_FLUSH_MS)
              }

              if (kind === 'user_message_chunk') {
                if (!text) return
                // Echo detection: the patch's _format_messages_as_prompt
                // bundles the whole conversation transcript into one big
                // text block before calling session/prompt. So when the
                // bridge fans our own outgoing prompt back as a
                // user_message_chunk, the text is NOT just our last input —
                // it's a multi-line bundle that ends with our latest input
                // (typically prefixed by "User:\n"). Match by suffix to
                // catch both shapes.
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
                // Flush any in-flight peer agent buffer first so events
                // appear in the order they happened.
                flushPeerAgentBuf()
                // Render as `role: 'system'` so the Ink TUI gives it the
                // muted single-line treatment (· glyph, no bubble). If the
                // peer's text is also a bundled transcript (unlikely but
                // possible if another Hermes-TUI peer is connected), trim
                // to the last User:\n segment so we show only their latest.
                let display = text
                const lastUserIdx = display.lastIndexOf('User:\n')
                if (lastUserIdx >= 0) {
                  display = display.slice(lastUserIdx + 'User:\n'.length).trim()
                }
                appendMessage({
                  role: 'system',
                  text: `🌐 peer: ${display}`
                } as Msg)
              } else if (kind === 'agent_message_chunk') {
                // Append to the peer-agent buffer and schedule a debounced
                // flush. Each token doesn't emit its own system line; we
                // wait for a quiet window (~600ms) then emit one coalesced
                // line. Punctuation/newlines naturally pause a stream so
                // this gives sentence-ish chunks.
                if (!text) return
                peerAgentBufRef.current += text
                schedulePeerAgentFlush()
              } else if (kind === 'tool_call') {
                flushPeerAgentBuf()
                const name = update.title ?? update.name ?? 'tool'
                const tkind = update.kind
                const label = tkind && tkind !== name ? `${name} (${tkind})` : String(name)
                appendMessage({
                  role: 'system',
                  text: `🌐 🔧 ${label}`
                } as Msg)
              } else if (kind === 'tool_call_update') {
                const status = update.status
                const contentText =
                  content && typeof content === 'object' ? String(content.text ?? '').trim() : ''
                if (contentText) {
                  flushPeerAgentBuf()
                  const snippet =
                    contentText.length > 120
                      ? contentText.slice(0, 120) + '…'
                      : contentText
                  appendMessage({
                    role: 'system',
                    text: `🌐    ${snippet}`
                  } as Msg)
                } else if (status && status !== 'in_progress') {
                  // Status-only update (e.g. completed) — surface briefly.
                  appendMessage({
                    role: 'system',
                    text: `🌐    (${status})`
                  } as Msg)
                }
              }
              // agent_thought_chunk and plan kinds remain hidden in v0 — most
              // noise/value trade-off lives in the agent_message_chunk +
              // tool_call paths above. Add explicit cases if you want them.
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
      if (peerAgentTimerRef.current) {
        clearTimeout(peerAgentTimerRef.current)
        peerAgentTimerRef.current = null
      }
      // Drop any half-buffered text on unmount; no need to flush since the
      // app is going down.
      peerAgentBufRef.current = ''
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
