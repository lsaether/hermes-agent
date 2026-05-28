"""Tests for compression-created continuation session provenance."""

from types import SimpleNamespace

from agent.conversation_compression import compress_context
from hermes_state import SessionDB


class _FakeTodoStore:
    def format_for_injection(self):
        return ""


class _FakeCompressor:
    compression_count = 1
    _last_compress_aborted = False
    _last_summary_error = None
    _last_aux_model_failure_model = None
    _last_aux_model_failure_error = None
    last_prompt_tokens = 0
    last_completion_tokens = 0

    def compress(self, messages, **_kwargs):
        return [{"role": "user", "content": "compressed summary"}]

    def on_session_start(self, *_args, **_kwargs):
        pass


def test_compression_split_creates_continuation_session_with_provenance(tmp_path):
    db = SessionDB(tmp_path / "state.db")
    try:
        db.create_session("root", source="cli", model="fake/model")

        agent = SimpleNamespace(
            _compression_feasibility_checked=True,
            session_id="root",
            model="fake/model",
            platform="cli",
            context_compressor=_FakeCompressor(),
            _memory_manager=None,
            _todo_store=_FakeTodoStore(),
            _session_db=db,
            _session_db_created=True,
            _session_init_model_config={"max_iterations": 90},
            _cached_system_prompt="old system",
            tools=None,
            _last_flushed_db_idx=2,
            commit_memory_session=lambda _messages: None,
            _emit_status=lambda _msg: None,
            _emit_warning=lambda _msg: None,
            _vprint=lambda *_args, **_kwargs: None,
            _invalidate_system_prompt=lambda: None,
            _build_system_prompt=lambda system_message: f"rebuilt: {system_message}",
        )

        compress_context(
            agent,
            [{"role": "user", "content": "hello"}],
            "system",
            approx_tokens=100,
            task_id="root",
        )

        continuation = db.get_session(agent.session_id)
        assert continuation is not None
        assert continuation["id"] != "root"
        assert continuation["parent_session_id"] == "root"
        assert continuation["session_kind"] == "continuation"
        assert continuation["root_session_id"] == "root"
        assert continuation["creator_kind"] == "compression"
        assert continuation["is_user_facing"] == 1
    finally:
        db.close()
