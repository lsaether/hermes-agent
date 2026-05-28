# Hermes Co-presence Experiment — WIP

This branch is the working state of an evening's exploration of giving Hermes
**multi-subscriber co-presence**: phone + desktop attached to the same live
Hermes session, both able to drive and receive in real time.

**Status: working proof-of-concept, NOT a clean PR.** Please don't merge upstream
as-is. See "Architectural ceiling" below for why.

## What's in this branch

29 commits ahead of `NousResearch/hermes-agent@main`, broken into three layers:

### Layer 1: rebase + fixes for the generalized-ACP-client patch

Starts from `flowforgelab/hermes-agent@feat/acpx-plugin` (the patch proposed in
[hermes-agent#5257](https://github.com/NousResearch/hermes-agent/issues/5257))
rebased onto current upstream/main. The fork was at v0.7-era and main has
moved ~5,800 commits since. Rebase took ~30 min of conflict resolution —
mostly dict-merge conflicts in `auth.py` and `providers.py`.

Fixes applied on top to make the patch actually work against current
hermes-acp v0.14+:

- `fix(acp_client): coerce httpx.Timeout to seconds` — patch's `float(timeout)`
  crashed on the httpx.Timeout object hermes' runtime passes.
- `feat(acp_client): emit streaming chunks when stream=True` — patch returned
  a non-streaming SimpleNamespace, but hermes' chat loop iterates the response.
- `fix(acp_client): drop --approve-all from acpx exec invocation` — current acpx
  CLI removed that flag; tool approval moved to protocol-level permission/request.
- `feat(acp_registry): use 'acpx --format json' for structured output` — current
  acpx defaults to human text, not NDJSON.
- `fix(acp_client): handle current acpx human-text output format` — defensive
  fallback for older acpx.
- `fix(acp_client): join collected lines with newlines` — empty-string join was
  mashing multi-line tool output.
- `fix(acp_client): structured parsing of NDJSON acpx output` — distinguishes
  agent_message_chunk / agent_thought_chunk / tool_call / tool_call_update for
  rendering.
- Added `hermes-acp` entry to `PROVIDER_REGISTRY`, `HERMES_OVERLAYS`, and the
  CLI argparse choices list (so `--provider hermes-acp` resolves).

After these, `hermes --tui --provider hermes-acp` works end-to-end against a
remote hermes-acp running on a WebSocket bridge (see hermes-bridge below).

### Layer 2: Ink TUI co-presence listener

New file: `ui-tui/src/app/usePeerMessageListener.ts` (~370 lines).

When `HERMES_BRIDGE_URL` is set, the Ink TUI opens a persistent WebSocket
subscriber to the bridge alongside its per-turn shim. The listener:

- Performs the ACP handshake (`initialize`, `session/new`) so it shares the
  bridge's cached ACP session id with the per-turn shim
- Accumulates each peer turn into a structured `PeerTurnAccumulator` —
  prompt, thinking, tool calls (with timing + duration), response, output
  char count
- Flushes per turn after 1500ms of silence, emitting three Msg objects: a
  `role:'user'` peer prompt with `🌐` marker, a `kind:'trail'` Msg with
  `thinking`/`tools` fields (rendered by the native `ToolTrail` component),
  and a dim `role:'system'` final response
- Dedups the bridge's echo of our own outgoing prompts via suffix-match
  against `lastUserMsgRef` (the patch bundles full transcript into
  `session/prompt`, so the echo doesn't equal the local input — it ends with it)
- Mutes ALL bridge fan-out for ~3 seconds after the user submits locally, so
  the agent's tool calls and response chunks for OUR turn don't bleed into
  a phantom peer turn
- Auto-reconnects on connection drops, rejects agent-initiated requests
  with `-32601` so the agent doesn't stall

Built via:

```bash
cd ui-tui && npm run build  # produces dist/entry.js
```

Hook wired into `useMainApp.ts` after the gateway event-subscription
useEffect.

### Layer 3: built dist bundle for ui-tui

`ui-tui/dist/entry.js` is gitignored. After cloning, rebuild via
`cd ui-tui && npm install && npm run build` — `hermes --tui` (without
`--tui-dev`) reads dist directly.

## Architectural ceiling

The experiment works for **peer turns** — when a peer (acp-tui, a phone PWA,
another Hermes TUI on the same bridge session) drives, the local Ink TUI
renders the peer's prompt + thinking trail + tool calls + response with the
same look the native renderer uses.

**For local turns it falls short.** When the LOCAL user types and the LOCAL
Hermes' AIAgent calls the patched ACPClient, the request goes through:

```
outer-Hermes AIAgent → patched ACPClient → ws-acp-shim → bridge → INNER hermes-acp
```

…where INNER hermes-acp runs its own full agent loop (thinks, calls tools,
gets results) and returns a *text blob* containing everything. The outer
Hermes' Ink TUI renders that text blob as a single message — so tool calls
appear as inline `🔧 terminal: printf 'OK'` markers instead of as native
`● Terminal("…") (0.4s) ✓` tree entries.

Root cause: the patch's `_run_acpx` flattens structured ACP events into one
response string. Restoring the structure would require either:

1. Refactoring `_run_acpx` to return structured turn data, then having
   ACPClient emit `delta.tool_calls` chunks — **but** outer Hermes' AIAgent
   would then try to execute the tool locally (double-execution; inner
   Hermes already ran it).
2. Faking `tool_progress_callback` events via deep plumbing into AIAgent.
3. Adding a custom marker syntax that the gateway parses (least invasive but
   touches two codebases).

None is a small change.

## The cleaner forward path

The "double-Hermes" architecture is the structural problem. To get
pixel-perfect local rendering AND co-presence, the cleaner answer is to
**not relay** — instead, build a TUI designed from day one to be both the
renderer AND a bridge subscriber, with no inner/outer Hermes split.

That plan is captured in `~/Code/hermes-copresence-tui-PLAN.md` in the
author's workspace. The relevant sibling repos this branch depends on:

- **hermes-bridge** — https://github.com/lsaether/hermes-bridge — the
  WebSocket multiplexer for any ACP server (multi-subscriber, session
  resolution, user-message echo, TTL grace).
- **ws-acp-shim** — branch `feat/ws-acp-shim` in hermes-bridge — translates
  the bridge's WebSocket back to stdio so off-the-shelf ACP clients (this
  patch, Zed, etc.) can attach.
- **acp-tui** — https://github.com/lsaether/acp-tui — minimal reference ACP
  client used as the "peer" in tests.

## What to use this branch for

- **Reading** the rebase + fixes if anyone tries to land #5257 against
  current main.
- **Forking** as a starting point if you want to keep iterating on the
  bolted-on architecture.
- **Reference** for the Ink TUI peer-listener integration shape if/when
  someone builds the cleaner replacement (option 3 above).

**Don't** open a PR from this branch as-is. The fixes (layer 1) are clean
enough to extract individually; the Ink TUI listener (layer 2) is a useful
proof but probably wants to live in a different shape upstream.
