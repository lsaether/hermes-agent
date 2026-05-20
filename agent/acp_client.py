"""OpenAI-compatible shim that forwards Hermes requests through acpx.

Spawns ``acpx <agent> exec '<prompt>'`` as a subprocess and collects the
response text.  All ACP protocol handling, authentication (including OAuth
gateway handshake), and session management is delegated to acpx.

Usage:
    client = ACPClient(agent_name="claude")
    resp = client.chat.completions.create(messages=[...], model="claude-acp")
"""

from __future__ import annotations

import json
import logging
import os
import shlex
import subprocess
import threading
from collections import deque
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Optional

from agent.acp_agent_registry import resolve_agent_command, resolve_agent_env, split_agent_command

logger = logging.getLogger(__name__)

ACP_MARKER_PREFIX = "acp://"
_DEFAULT_TIMEOUT_SECONDS = 900.0


def _stream_chat_completion(response_text: str, usage: Any, model: str | None):
    """Yield OpenAI-style streaming chunks for a single full response.

    Hermes' chat-completion consumer iterates the response when ``stream=True``;
    we don't have token-level streaming from acpx exec, so we emit:

      1. Opening chunk: delta.role="assistant", no content.
      2. Content chunk: delta.content=<full response>.
      3. Final chunk: empty delta, finish_reason="stop", usage attached.
    """
    model_id = model or "acp"
    chunk_id = f"acp-stream-{id(response_text)}"
    # Opening chunk
    yield SimpleNamespace(
        id=chunk_id,
        model=model_id,
        object="chat.completion.chunk",
        choices=[
            SimpleNamespace(
                index=0,
                delta=SimpleNamespace(role="assistant", content=None, tool_calls=None),
                finish_reason=None,
            )
        ],
        usage=None,
    )
    # Content chunk
    yield SimpleNamespace(
        id=chunk_id,
        model=model_id,
        object="chat.completion.chunk",
        choices=[
            SimpleNamespace(
                index=0,
                delta=SimpleNamespace(content=response_text, tool_calls=None),
                finish_reason=None,
            )
        ],
        usage=None,
    )
    # Final chunk
    yield SimpleNamespace(
        id=chunk_id,
        model=model_id,
        object="chat.completion.chunk",
        choices=[
            SimpleNamespace(
                index=0,
                delta=SimpleNamespace(content=None, tool_calls=None),
                finish_reason="stop",
            )
        ],
        usage=usage,
    )


def _timeout_to_seconds(timeout: Any) -> float:
    """Coerce a timeout value (float, int, httpx.Timeout, or None) to seconds.

    Hermes' agent runtime passes an ``httpx.Timeout`` object through the
    OpenAI client kwargs. The acpx subprocess invocation needs a plain number
    of seconds. Pick the most permissive available field: ``read`` if set,
    else fall back to whatever total or scalar value is available.
    """
    if timeout is None:
        return _DEFAULT_TIMEOUT_SECONDS
    if isinstance(timeout, (int, float)):
        return float(timeout)
    for attr in ("read", "total", "connect", "pool"):
        val = getattr(timeout, attr, None)
        if val is not None:
            try:
                return float(val)
            except (TypeError, ValueError):
                continue
    return _DEFAULT_TIMEOUT_SECONDS


def extract_agent_from_url(base_url: str) -> Optional[str]:
    """Extract agent name from an ``acp://<agent>`` URL, or return ``None``."""
    if not base_url or not base_url.startswith(ACP_MARKER_PREFIX):
        return None
    return base_url[len(ACP_MARKER_PREFIX):].strip().lower() or None


def _format_messages_as_prompt(
    messages: list[dict[str, Any]],
    model: str | None = None,
    agent_name: str = "ACP agent",
) -> str:
    """Flatten OpenAI-format messages into a single prompt string."""
    sections: list[str] = []
    if model:
        sections.append(f"Hermes requested model hint: {model}")

    transcript: list[str] = []
    for message in messages:
        if not isinstance(message, dict):
            continue
        role = str(message.get("role") or "unknown").strip().lower()
        if role not in {"system", "user", "assistant", "tool"}:
            role = "context"

        content = message.get("content")
        rendered = _render_content(content)
        if not rendered:
            continue

        label = {"system": "System", "user": "User", "assistant": "Assistant",
                 "tool": "Tool", "context": "Context"}.get(role, role.title())
        transcript.append(f"{label}:\n{rendered}")

    if transcript:
        sections.append("\n\n".join(transcript))

    return "\n\n".join(s.strip() for s in sections if s and s.strip())


def _render_content(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, dict):
        return str(content.get("text") or content.get("content") or json.dumps(content)).strip()
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                text = item.get("text")
                if isinstance(text, str) and text.strip():
                    parts.append(text.strip())
        return "\n".join(parts).strip()
    return str(content).strip()


# ---------------------------------------------------------------------------
# OpenAI-compatible namespace shims
# ---------------------------------------------------------------------------

class _ACPChatCompletions:
    def __init__(self, client: "ACPClient"):
        self._client = client

    def create(self, **kwargs: Any) -> Any:
        return self._client._create_chat_completion(**kwargs)


class _ACPChatNamespace:
    def __init__(self, client: "ACPClient"):
        self.completions = _ACPChatCompletions(client)


# ---------------------------------------------------------------------------
# Main client — thin wrapper around acpx
# ---------------------------------------------------------------------------

class ACPClient:
    """Minimal OpenAI-client-compatible facade that delegates to acpx."""

    def __init__(
        self,
        *,
        agent_name: str | None = None,
        api_key: str | None = None,
        base_url: str | None = None,
        default_headers: dict[str, str] | None = None,
        acp_command: str | None = None,
        acp_args: list[str] | None = None,
        acp_cwd: str | None = None,
        command: str | None = None,
        args: list[str] | None = None,
        **_: Any,
    ):
        self._agent_name = agent_name or extract_agent_from_url(base_url or "") or "unknown"

        # Resolve the command to spawn (typically "npx -y acpx <agent>")
        if acp_command or command:
            self._acp_argv = shlex.split(acp_command or command or "")
            if acp_args or args:
                self._acp_argv.extend(acp_args or args or [])
        else:
            resolved = resolve_agent_command(self._agent_name)
            if resolved is None:
                from agent.acp_agent_registry import list_agents
                raise ValueError(
                    f"Unknown ACP agent '{self._agent_name}'. "
                    f"Set HERMES_ACP_{self._agent_name.upper().replace('-', '_')}_COMMAND or "
                    f"choose from: {', '.join(list_agents())}"
                )
            self._acp_argv = split_agent_command(resolved)

        self._acp_cwd = str(Path(acp_cwd or os.getcwd()).resolve())
        self._auth_env = resolve_agent_env(self._agent_name)

        self.api_key = api_key or f"{self._agent_name}-acp"
        self.base_url = base_url or f"acp://{self._agent_name}"
        self._default_headers = dict(default_headers or {})
        self.chat = _ACPChatNamespace(self)
        self.is_closed = False
        self._active_process: subprocess.Popen[str] | None = None
        self._active_process_lock = threading.Lock()

    @property
    def agent_name(self) -> str:
        return self._agent_name

    def close(self) -> None:
        proc: subprocess.Popen[str] | None
        with self._active_process_lock:
            proc = self._active_process
            self._active_process = None
        self.is_closed = True
        if proc is None:
            return
        try:
            proc.terminate()
            proc.wait(timeout=2)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass

    def _create_chat_completion(
        self,
        *,
        model: str | None = None,
        messages: list[dict[str, Any]] | None = None,
        timeout: Any = None,
        stream: bool = False,
        **_: Any,
    ) -> Any:
        prompt_text = _format_messages_as_prompt(
            messages or [], model=model, agent_name=self._agent_name,
        )
        response_text = self._run_acpx(
            prompt_text,
            timeout_seconds=_timeout_to_seconds(timeout),
        )

        usage = SimpleNamespace(
            prompt_tokens=0, completion_tokens=0, total_tokens=0,
            prompt_tokens_details=SimpleNamespace(cached_tokens=0),
        )

        if stream:
            return _stream_chat_completion(response_text, usage, model)

        assistant_message = SimpleNamespace(
            content=response_text,
            tool_calls=[],
            reasoning=None,
            reasoning_content=None,
            reasoning_details=None,
        )
        choice = SimpleNamespace(message=assistant_message, finish_reason="stop")
        return SimpleNamespace(
            choices=[choice],
            usage=usage,
            model=model or f"{self._agent_name}-acp",
        )

    def _run_acpx(self, prompt_text: str, *, timeout_seconds: float) -> str:
        """Spawn acpx with the prompt and collect the response text."""
        # Build the full command: acpx <agent> exec '<prompt>'
        # NOTE: the patch's original version appended --approve-all, but the
        # current acpx CLI no longer accepts that flag (tool approval moved to
        # protocol-level permission/request). Removing it unblocks claude-acp.
        argv = self._acp_argv + ["exec", prompt_text]

        # Build subprocess env: inherit parent + inject auth vars
        spawn_env: dict[str, str] | None = None
        if self._auth_env:
            spawn_env = {**os.environ, **self._auth_env}

        try:
            proc = subprocess.Popen(
                argv,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,
                cwd=self._acp_cwd,
                env=spawn_env,
            )
        except FileNotFoundError as exc:
            raise RuntimeError(
                f"Could not start ACP agent '{self._agent_name}' "
                f"(command: {' '.join(argv)}). "
                f"Ensure acpx is installed: npm install -g acpx"
            ) from exc

        self.is_closed = False
        with self._active_process_lock:
            self._active_process = proc

        stderr_tail: deque[str] = deque(maxlen=40)

        def _stderr_reader() -> None:
            if proc.stderr is None:
                return
            for line in proc.stderr:
                stderr_tail.append(line.rstrip("\n"))

        err_thread = threading.Thread(target=_stderr_reader, daemon=True)
        err_thread.start()

        # Collect all stdout. Older acpx emitted NDJSON; current acpx emits
        # human-readable text (lines starting with [client], [done], plus the
        # plain-text response body). Handle both formats.
        text_parts: list[str] = []
        try:
            if proc.stdin:
                proc.stdin.close()

            for line in proc.stdout or []:
                raw_line = line.rstrip("\n")
                stripped = raw_line.strip()
                if not stripped:
                    continue

                # Try NDJSON path first (older acpx).
                try:
                    event = json.loads(stripped)
                except (json.JSONDecodeError, ValueError):
                    event = None

                if isinstance(event, dict):
                    if event.get("method") == "session/update":
                        params = event.get("params") or {}
                        update = params.get("update") or {}
                        kind = str(update.get("sessionUpdate") or "")
                        content = update.get("content") or {}
                        chunk = (
                            str(content.get("text") or "")
                            if isinstance(content, dict)
                            else ""
                        )
                        if kind == "agent_message_chunk" and chunk:
                            text_parts.append(chunk)
                    if "text" in event:
                        text_parts.append(str(event["text"]))
                    continue

                # Human-text path (current acpx). Skip status markers; treat
                # everything else as part of the response body.
                if stripped.startswith("[client]") or stripped.startswith("[done]"):
                    continue
                text_parts.append(raw_line)

            proc.wait(timeout=timeout_seconds)

        except subprocess.TimeoutExpired:
            proc.kill()
            raise TimeoutError(
                f"ACP agent '{self._agent_name}' timed out after {timeout_seconds}s"
            )
        finally:
            self.close()

        if proc.returncode and proc.returncode != 0:
            stderr_text = "\n".join(stderr_tail).strip()
            # Check for auth errors
            if "401" in stderr_text or "authentication" in stderr_text.lower():
                raise RuntimeError(
                    f"ACP agent '{self._agent_name}' authentication failed: {stderr_text}"
                )
            if stderr_text:
                raise RuntimeError(
                    f"ACP agent '{self._agent_name}' failed (exit {proc.returncode}): {stderr_text}"
                )

        response = "\n".join(text_parts).strip()
        if not response:
            # Fallback: try to get any stdout that wasn't NDJSON
            stderr_text = "\n".join(stderr_tail).strip()
            if stderr_text:
                raise RuntimeError(
                    f"ACP agent '{self._agent_name}' returned no output. stderr: {stderr_text}"
                )
        return response
