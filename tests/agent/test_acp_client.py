"""Tests for the generalised ACP client."""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
import threading
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest import mock

import pytest

from agent.acp_client import (
    ACPClient,
    _ensure_path_within_cwd,
    _format_messages_as_prompt,
    _jsonrpc_error,
    _render_message_content,
    extract_agent_from_url,
)


# ---------------------------------------------------------------------------
# extract_agent_from_url
# ---------------------------------------------------------------------------

class TestExtractAgentFromUrl:
    def test_claude(self):
        assert extract_agent_from_url("acp://claude") == "claude"

    def test_codex(self):
        assert extract_agent_from_url("acp://codex") == "codex"

    def test_copilot(self):
        assert extract_agent_from_url("acp://copilot") == "copilot"

    def test_non_acp_url(self):
        assert extract_agent_from_url("https://api.openai.com") is None

    def test_empty(self):
        assert extract_agent_from_url("") is None

    def test_bare_prefix(self):
        assert extract_agent_from_url("acp://") is None


# ---------------------------------------------------------------------------
# Message formatting
# ---------------------------------------------------------------------------

class TestFormatMessages:
    def test_basic_user_message(self):
        msgs = [{"role": "user", "content": "Hello"}]
        result = _format_messages_as_prompt(msgs, agent_name="claude")
        assert "User:\nHello" in result
        assert "agent: claude" in result

    def test_system_and_user(self):
        msgs = [
            {"role": "system", "content": "Be helpful"},
            {"role": "user", "content": "Hi"},
        ]
        result = _format_messages_as_prompt(msgs)
        assert "System:\nBe helpful" in result
        assert "User:\nHi" in result

    def test_model_hint(self):
        result = _format_messages_as_prompt([], model="gpt-5")
        assert "gpt-5" in result

    def test_empty_messages(self):
        result = _format_messages_as_prompt([])
        assert "Continue the conversation" in result


class TestRenderMessageContent:
    def test_string(self):
        assert _render_message_content("hello") == "hello"

    def test_none(self):
        assert _render_message_content(None) == ""

    def test_dict_with_text(self):
        assert _render_message_content({"text": "hi"}) == "hi"

    def test_list_of_parts(self):
        parts = [{"text": "a"}, {"text": "b"}]
        assert _render_message_content(parts) == "a\nb"


# ---------------------------------------------------------------------------
# ACPClient init
# ---------------------------------------------------------------------------

class TestACPClientInit:
    def test_known_agent(self):
        client = ACPClient(agent_name="gemini")
        assert client.agent_name == "gemini"
        assert client.base_url == "acp://gemini"

    def test_agent_from_base_url(self):
        client = ACPClient(base_url="acp://codex")
        assert client.agent_name == "codex"

    def test_unknown_agent_raises(self):
        with pytest.raises(ValueError, match="Unknown ACP agent"):
            ACPClient(agent_name="nonexistent-xyz")

    def test_custom_command(self):
        client = ACPClient(agent_name="custom", acp_command="/bin/my-agent --acp")
        assert client.agent_name == "custom"

    def test_close_idempotent(self):
        client = ACPClient(agent_name="gemini")
        client.close()
        client.close()  # should not raise


# ---------------------------------------------------------------------------
# Backwards compatibility
# ---------------------------------------------------------------------------

class TestCopilotBackwardsCompat:
    def test_import(self):
        from agent.copilot_acp_client import CopilotACPClient, ACP_MARKER_BASE_URL
        assert ACP_MARKER_BASE_URL == "acp://copilot"

    def test_creates_copilot_agent(self):
        from agent.copilot_acp_client import CopilotACPClient
        client = CopilotACPClient()
        assert client.agent_name == "copilot"
        assert client.base_url == "acp://copilot"


# ---------------------------------------------------------------------------
# ACP protocol flow (mocked subprocess)
# ---------------------------------------------------------------------------

class TestACPProtocolFlow:
    """Test the full initialize → session/new → session/prompt flow with a mock process."""

    def _make_mock_process(self, responses: list[dict[str, Any]]) -> mock.MagicMock:
        """Create a mock Popen that feeds back canned ACP responses."""
        proc = mock.MagicMock()
        proc.poll.return_value = None

        # Track what's written to stdin
        written_lines: list[str] = []

        class FakeStdin:
            def write(self, data: str) -> None:
                written_lines.append(data)

            def flush(self) -> None:
                pass

        proc.stdin = FakeStdin()
        proc._written = written_lines

        # Feed responses through stdout as NDJSON lines
        response_iter = iter(responses)

        def line_generator():
            for resp in response_iter:
                yield json.dumps(resp) + "\n"

        proc.stdout = line_generator()
        proc.stderr = iter([])  # empty stderr
        return proc

    def test_successful_prompt(self):
        """Full ACP flow returns assembled text."""
        responses = [
            # initialize response
            {"jsonrpc": "2.0", "id": 1, "result": {"protocolVersion": 1}},
            # session/new response
            {"jsonrpc": "2.0", "id": 2, "result": {"sessionId": "sess-123"}},
            # streaming text chunks
            {
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "update": {
                        "sessionUpdate": "agent_message_chunk",
                        "content": {"text": "Hello "},
                    }
                },
            },
            {
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "update": {
                        "sessionUpdate": "agent_message_chunk",
                        "content": {"text": "world!"},
                    }
                },
            },
            # session/prompt response
            {"jsonrpc": "2.0", "id": 3, "result": {"stopReason": "completed"}},
        ]

        with mock.patch("subprocess.Popen") as mock_popen:
            proc = self._make_mock_process(responses)
            mock_popen.return_value = proc

            client = ACPClient(agent_name="gemini")
            result = client.chat.completions.create(
                messages=[{"role": "user", "content": "Hi"}],
                model="gemini-acp",
            )

            assert result.choices[0].message.content == "Hello world!"
            assert result.model == "gemini-acp"

    def test_reasoning_chunks(self):
        """Thought chunks are captured as reasoning."""
        responses = [
            {"jsonrpc": "2.0", "id": 1, "result": {"protocolVersion": 1}},
            {"jsonrpc": "2.0", "id": 2, "result": {"sessionId": "sess-456"}},
            {
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "update": {
                        "sessionUpdate": "agent_thought_chunk",
                        "content": {"text": "thinking..."},
                    }
                },
            },
            {
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "update": {
                        "sessionUpdate": "agent_message_chunk",
                        "content": {"text": "answer"},
                    }
                },
            },
            {"jsonrpc": "2.0", "id": 3, "result": {"stopReason": "completed"}},
        ]

        with mock.patch("subprocess.Popen") as mock_popen:
            mock_popen.return_value = self._make_mock_process(responses)
            client = ACPClient(agent_name="gemini")
            result = client.chat.completions.create(
                messages=[{"role": "user", "content": "Think"}],
            )

            assert result.choices[0].message.content == "answer"
            assert result.choices[0].message.reasoning == "thinking..."

    def test_agent_not_found_error(self):
        """FileNotFoundError from Popen becomes a clear RuntimeError."""
        with mock.patch("subprocess.Popen", side_effect=FileNotFoundError("not found")):
            client = ACPClient(agent_name="gemini")
            with pytest.raises(RuntimeError, match="Could not start ACP agent 'gemini'"):
                client.chat.completions.create(
                    messages=[{"role": "user", "content": "Hi"}],
                )

    def test_process_exits_early_with_stderr(self):
        """Process dying mid-flow surfaces stderr in the error."""
        responses = [
            {"jsonrpc": "2.0", "id": 1, "result": {"protocolVersion": 1}},
        ]
        proc = self._make_mock_process(responses)
        # Simulate process dying after initialize
        proc.poll.return_value = 1
        proc.stderr = iter(["Fatal: auth token expired\n"])

        with mock.patch("subprocess.Popen", return_value=proc):
            client = ACPClient(agent_name="gemini")
            with pytest.raises(RuntimeError, match="auth token expired"):
                client.chat.completions.create(
                    messages=[{"role": "user", "content": "Hi"}],
                )

    def test_acp_error_response(self):
        """ACP protocol error in response is surfaced."""
        responses = [
            {
                "jsonrpc": "2.0",
                "id": 1,
                "error": {"code": -32000, "message": "Authentication required"},
            },
        ]
        with mock.patch("subprocess.Popen", return_value=self._make_mock_process(responses)):
            client = ACPClient(agent_name="gemini")
            with pytest.raises(RuntimeError, match="Authentication required"):
                client.chat.completions.create(
                    messages=[{"role": "user", "content": "Hi"}],
                )

    def test_no_session_id_error(self):
        """Missing sessionId in session/new response is caught."""
        responses = [
            {"jsonrpc": "2.0", "id": 1, "result": {"protocolVersion": 1}},
            {"jsonrpc": "2.0", "id": 2, "result": {}},  # no sessionId
        ]
        with mock.patch("subprocess.Popen", return_value=self._make_mock_process(responses)):
            client = ACPClient(agent_name="gemini")
            with pytest.raises(RuntimeError, match="did not return a sessionId"):
                client.chat.completions.create(
                    messages=[{"role": "user", "content": "Hi"}],
                )

    def test_fs_read_callback(self):
        """Agent requesting fs/read_text_file gets file content back."""
        with tempfile.TemporaryDirectory() as tmpdir:
            test_file = Path(tmpdir) / "hello.txt"
            test_file.write_text("file contents here")

            responses = [
                {"jsonrpc": "2.0", "id": 1, "result": {"protocolVersion": 1}},
                {"jsonrpc": "2.0", "id": 2, "result": {"sessionId": "s1"}},
                # Agent requests a file read
                {
                    "jsonrpc": "2.0",
                    "id": 100,
                    "method": "fs/read_text_file",
                    "params": {"path": str(test_file)},
                },
                # Then sends a text chunk and completes
                {
                    "jsonrpc": "2.0",
                    "method": "session/update",
                    "params": {
                        "update": {
                            "sessionUpdate": "agent_message_chunk",
                            "content": {"text": "got it"},
                        }
                    },
                },
                {"jsonrpc": "2.0", "id": 3, "result": {"stopReason": "completed"}},
            ]

            proc = self._make_mock_process(responses)
            with mock.patch("subprocess.Popen", return_value=proc):
                client = ACPClient(agent_name="gemini", acp_cwd=tmpdir)
                result = client.chat.completions.create(
                    messages=[{"role": "user", "content": "Read that file"}],
                )
                assert result.choices[0].message.content == "got it"

                # Verify the response was written back to stdin
                written = [json.loads(line) for line in proc._written if line.strip()]
                read_responses = [
                    w for w in written
                    if w.get("id") == 100 and "result" in w
                ]
                assert len(read_responses) == 1
                assert read_responses[0]["result"]["content"] == "file contents here"

    def test_fs_read_path_traversal_blocked(self):
        """File read outside cwd is rejected."""
        with tempfile.TemporaryDirectory() as tmpdir:
            responses = [
                {"jsonrpc": "2.0", "id": 1, "result": {"protocolVersion": 1}},
                {"jsonrpc": "2.0", "id": 2, "result": {"sessionId": "s1"}},
                {
                    "jsonrpc": "2.0",
                    "id": 100,
                    "method": "fs/read_text_file",
                    "params": {"path": "/etc/passwd"},
                },
                {
                    "jsonrpc": "2.0",
                    "method": "session/update",
                    "params": {
                        "update": {
                            "sessionUpdate": "agent_message_chunk",
                            "content": {"text": "ok"},
                        }
                    },
                },
                {"jsonrpc": "2.0", "id": 3, "result": {"stopReason": "completed"}},
            ]

            proc = self._make_mock_process(responses)
            with mock.patch("subprocess.Popen", return_value=proc):
                client = ACPClient(agent_name="gemini", acp_cwd=tmpdir)
                client.chat.completions.create(
                    messages=[{"role": "user", "content": "read /etc/passwd"}],
                )
                # Verify the error response was sent
                written = [json.loads(line) for line in proc._written if line.strip()]
                error_responses = [
                    w for w in written
                    if w.get("id") == 100 and "error" in w
                ]
                assert len(error_responses) == 1
                assert "outside" in error_responses[0]["error"]["message"]

    def test_permission_request_auto_allowed(self):
        """Permission requests are auto-allowed with allow_once."""
        responses = [
            {"jsonrpc": "2.0", "id": 1, "result": {"protocolVersion": 1}},
            {"jsonrpc": "2.0", "id": 2, "result": {"sessionId": "s1"}},
            {
                "jsonrpc": "2.0",
                "id": 200,
                "method": "session/request_permission",
                "params": {"permission": "write_file"},
            },
            {
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "update": {
                        "sessionUpdate": "agent_message_chunk",
                        "content": {"text": "done"},
                    }
                },
            },
            {"jsonrpc": "2.0", "id": 3, "result": {"stopReason": "completed"}},
        ]

        proc = self._make_mock_process(responses)
        with mock.patch("subprocess.Popen", return_value=proc):
            client = ACPClient(agent_name="gemini")
            result = client.chat.completions.create(
                messages=[{"role": "user", "content": "Do something"}],
            )
            assert result.choices[0].message.content == "done"

            written = [json.loads(line) for line in proc._written if line.strip()]
            perm_responses = [w for w in written if w.get("id") == 200]
            assert len(perm_responses) == 1
            assert perm_responses[0]["result"]["outcome"]["outcome"] == "allow_once"


# ---------------------------------------------------------------------------
# Path security
# ---------------------------------------------------------------------------

class TestPathSecurity:
    def test_absolute_within_cwd(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            target = Path(tmpdir) / "sub" / "file.txt"
            result = _ensure_path_within_cwd(str(target), tmpdir)
            assert result == target.resolve()

    def test_relative_path_rejected(self):
        with pytest.raises(PermissionError, match="must be absolute"):
            _ensure_path_within_cwd("relative/path.txt", "/tmp")

    def test_traversal_rejected(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            with pytest.raises(PermissionError, match="outside"):
                _ensure_path_within_cwd("/etc/passwd", tmpdir)

    def test_symlink_traversal_rejected(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            link = Path(tmpdir) / "escape"
            try:
                link.symlink_to("/etc")
            except OSError:
                pytest.skip("Cannot create symlinks")
            with pytest.raises(PermissionError, match="outside"):
                _ensure_path_within_cwd(str(link / "passwd"), tmpdir)


# ---------------------------------------------------------------------------
# Provider overlay wiring
# ---------------------------------------------------------------------------

class TestProviderOverlays:
    def test_acp_providers_registered(self):
        from hermes_cli.providers import HERMES_OVERLAYS
        expected_agents = [
            "claude-acp", "codex-acp", "gemini-acp", "cursor-acp",
            "kiro-acp", "kilocode-acp", "opencode-acp", "kimi-acp",
            "qwen-acp", "cline-acp", "amp-acp", "droid-acp", "iflow-acp",
            "copilot-acp",
        ]
        for provider_id in expected_agents:
            assert provider_id in HERMES_OVERLAYS, f"Missing overlay: {provider_id}"
            overlay = HERMES_OVERLAYS[provider_id]
            assert overlay.auth_type == "external_process"
            agent_name = provider_id.removesuffix("-acp")
            assert overlay.base_url_override == f"acp://{agent_name}"

    def test_agent_name_derivation_from_provider(self):
        """Verify that provider-id → agent-name derivation works for routing."""
        from agent.acp_client import extract_agent_from_url
        from hermes_cli.providers import HERMES_OVERLAYS

        for provider_id in ["claude-acp", "codex-acp", "gemini-acp"]:
            overlay = HERMES_OVERLAYS[provider_id]
            agent = extract_agent_from_url(overlay.base_url_override)
            assert agent == provider_id.removesuffix("-acp")


# ---------------------------------------------------------------------------
# JSON-RPC helpers
# ---------------------------------------------------------------------------

class TestJsonRpcHelpers:
    def test_error_format(self):
        err = _jsonrpc_error(42, -32601, "Method not found")
        assert err["jsonrpc"] == "2.0"
        assert err["id"] == 42
        assert err["error"]["code"] == -32601
        assert err["error"]["message"] == "Method not found"
