from __future__ import annotations

from types import SimpleNamespace

import pytest


class _FakeSessionDB:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []

    def end_session(self, session_id: str, end_reason: str) -> None:
        self.calls.append((session_id, end_reason))


def test_finalize_single_query_uses_current_agent_session_id() -> None:
    """Single-query cleanup must close the live continuation session.

    Auto-compression can rotate ``agent.session_id`` during the turn.  The
    finalizer should therefore prefer the agent's current session id over the
    CLI object's initially-created session id.
    """
    import cli as cli_mod

    db = _FakeSessionDB()
    shell = SimpleNamespace(
        session_id="parent-session",
        agent=SimpleNamespace(session_id="continuation-session"),
        _session_db=db,
        _last_turn_interrupted=False,
    )

    cli_mod._finalize_single_query_session(shell, {"completed": True})

    assert db.calls == [("continuation-session", "single_query_complete")]


def test_finalize_single_query_records_failed_result() -> None:
    import cli as cli_mod

    db = _FakeSessionDB()
    shell = SimpleNamespace(
        session_id="single-query-session",
        agent=SimpleNamespace(session_id="single-query-session"),
        _session_db=db,
        _last_turn_interrupted=False,
    )

    cli_mod._finalize_single_query_session(shell, {"failed": True})

    assert db.calls == [("single-query-session", "single_query_failed")]


def test_finalize_single_query_records_interrupted_result() -> None:
    import cli as cli_mod

    db = _FakeSessionDB()
    shell = SimpleNamespace(
        session_id="single-query-session",
        agent=SimpleNamespace(session_id="single-query-session"),
        _session_db=db,
        _last_turn_interrupted=True,
    )

    cli_mod._finalize_single_query_session(shell, {"failed": True})

    assert db.calls == [("single-query-session", "single_query_interrupted")]


def test_quiet_single_query_main_finalizes_session(monkeypatch) -> None:
    """The machine-readable ``hermes chat -q -Q`` path exits via sys.exit()."""
    import cli as cli_mod

    db = _FakeSessionDB()

    class FakeAgent:
        session_id = "quiet-agent-session"

        def run_conversation(self, **_kwargs):
            return {"final_response": "done", "completed": True, "failed": False}

    class FakeCLI:
        def __init__(self, **_kwargs) -> None:
            self.session_id = "initial-cli-session"
            self.agent = FakeAgent()
            self._session_db = db
            self.conversation_history = []
            self._active_agent_route_signature = "same"
            self.tool_progress_mode = "all"
            self._last_turn_interrupted = False

        def _ensure_runtime_credentials(self) -> bool:
            return True

        def _resolve_turn_agent_config(self, _message):
            return {
                "signature": "same",
                "model": None,
                "runtime": None,
                "request_overrides": None,
            }

        def _init_agent(self, **_kwargs) -> bool:
            return True

    monkeypatch.setattr(cli_mod, "HermesCLI", FakeCLI)
    monkeypatch.setattr(cli_mod.atexit, "register", lambda *_args, **_kwargs: None)

    with pytest.raises(SystemExit) as exc_info:
        cli_mod.main(query="hello", quiet=True, toolsets="terminal")

    assert exc_info.value.code == 0
    assert db.calls == [("quiet-agent-session", "single_query_complete")]


def test_human_single_query_main_finalizes_session(monkeypatch) -> None:
    """The normal human-facing ``hermes chat -q`` path should also close DB state."""
    import cli as cli_mod

    db = _FakeSessionDB()

    class _Console:
        def print(self, *_args, **_kwargs) -> None:
            pass

    class FakeAgent:
        session_id = "human-agent-session"

    class FakeCLI:
        def __init__(self, **_kwargs) -> None:
            self.session_id = "initial-cli-session"
            self.agent = FakeAgent()
            self._session_db = db
            self.conversation_history = []
            self.console = _Console()
            self._last_turn_interrupted = False

        def _show_security_advisories(self) -> None:
            pass

        def chat(self, _query, images=None):
            assert images is None
            return "done"

        def _print_exit_summary(self) -> None:
            pass

    monkeypatch.setattr(cli_mod, "HermesCLI", FakeCLI)
    monkeypatch.setattr(cli_mod.atexit, "register", lambda *_args, **_kwargs: None)

    cli_mod.main(query="hello", quiet=False, toolsets="terminal")

    assert db.calls == [("human-agent-session", "single_query_complete")]
