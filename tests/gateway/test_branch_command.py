"""Tests for /branch gateway slash command provenance."""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from gateway.config import Platform
from gateway.platforms.base import MessageEvent
from gateway.session import SessionSource


def _make_event(text="/branch experiment", platform=Platform.TELEGRAM, user_id="12345", chat_id="67890"):
    source = SessionSource(
        platform=platform,
        user_id=user_id,
        chat_id=chat_id,
        user_name="testuser",
    )
    return MessageEvent(text=text, source=source)


def _make_runner(session_db):
    from gateway.run import GatewayRunner

    runner = object.__new__(GatewayRunner)
    runner.adapters = {}
    runner.config = {"model": {"default": "test/model"}}
    runner._session_db = session_db
    runner._clear_session_boundary_security_state = MagicMock()
    runner._evict_cached_agent = MagicMock()

    current_entry = MagicMock()
    current_entry.session_id = "parent-session"
    current_entry.session_key = "telegram:12345:67890"

    new_entry = MagicMock()
    new_entry.session_id = "branched-session"
    new_entry.session_key = current_entry.session_key

    mock_store = MagicMock()
    mock_store._generate_session_key.return_value = current_entry.session_key
    mock_store.get_or_create_session.return_value = current_entry
    mock_store.load_transcript.return_value = [
        {"role": "user", "content": "original prompt"},
        {"role": "assistant", "content": "original response"},
    ]
    mock_store.switch_session.return_value = new_entry
    runner.session_store = mock_store
    return runner, mock_store


@pytest.mark.asyncio
async def test_gateway_branch_stamps_session_provenance(tmp_path):
    from hermes_state import SessionDB

    db = SessionDB(db_path=tmp_path / "state.db")
    db.create_session("root-session", source="telegram", model="test/model")
    db.create_session(
        "parent-session",
        source="telegram",
        model="test/model",
        parent_session_id="root-session",
    )

    runner, store = _make_runner(db)

    result = await runner._handle_branch_command(_make_event())

    new_session_id = store.switch_session.call_args.args[1]
    row = db.get_session(new_session_id)
    assert row is not None
    assert row["parent_session_id"] == "parent-session"
    assert row["root_session_id"] == "root-session"
    assert row["session_kind"] == "branch"
    assert row["creator_kind"] == "command"
    assert row["creator_command"] == "/branch"
    assert bool(row["is_user_facing"]) is True
    assert "parent-session" in result
    assert new_session_id in result
