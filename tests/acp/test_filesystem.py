"""Tests for ACP editor filesystem dirty-buffer integration."""

from __future__ import annotations

import asyncio
import json
import uuid
from types import SimpleNamespace

import pytest
from acp.schema import ClientCapabilities, FileSystemCapabilities

from acp_adapter import filesystem as acp_filesystem
from acp_adapter.server import HermesACPAgent
from tools.file_tools import patch_tool, read_file_tool, write_file_tool


class FakeACPClient:
    def __init__(self, *, read_content: str = "dirty\nbuffer\n", fail: Exception | None = None):
        self.read_content = read_content
        self.fail = fail
        self.read_calls: list[dict] = []
        self.write_calls: list[dict] = []

    async def read_text_file(self, **kwargs):
        self.read_calls.append(kwargs)
        if self.fail is not None:
            raise self.fail
        return SimpleNamespace(content=self.read_content)

    async def write_text_file(self, **kwargs):
        self.write_calls.append(kwargs)
        if self.fail is not None:
            raise self.fail
        return None


def _caps(*, read: bool = False, write: bool = False) -> ClientCapabilities:
    return ClientCapabilities(
        fs=FileSystemCapabilities(readTextFile=read, writeTextFile=write)
    )


async def _with_acp_context(fn, *, client, session_id, cwd, capabilities):
    loop = asyncio.get_running_loop()

    def run_in_tool_thread():
        with acp_filesystem.use_acp_filesystem(
            client=client,
            session_id=session_id,
            loop=loop,
            cwd=str(cwd),
            capabilities=capabilities,
        ):
            return fn()

    return await asyncio.to_thread(run_in_tool_thread)


@pytest.mark.asyncio
async def test_dirty_buffer_read_uses_acp_client(tmp_path):
    disk_file = tmp_path / "example.txt"
    disk_file.write_text("clean disk\n", encoding="utf-8")
    client = FakeACPClient(read_content="dirty buffer\nsecond line\n")
    task_id = f"acp-fs-read-{uuid.uuid4()}"

    raw = await _with_acp_context(
        lambda: read_file_tool("example.txt", offset=1, limit=5, task_id=task_id),
        client=client,
        session_id="session-1",
        cwd=tmp_path,
        capabilities=_caps(read=True),
    )

    payload = json.loads(raw)
    assert "dirty buffer" in payload["content"]
    assert "clean disk" not in payload["content"]
    assert client.read_calls == [
        {
            "path": str(disk_file),
            "session_id": "session-1",
            "limit": 5,
            "line": 1,
        }
    ]


def test_no_capability_read_falls_back_to_local_disk(tmp_path):
    disk_file = tmp_path / "example.txt"
    disk_file.write_text("clean disk\n", encoding="utf-8")
    client = FakeACPClient(read_content="dirty buffer\n")
    task_id = f"acp-fs-fallback-{uuid.uuid4()}"

    async def run():
        return await _with_acp_context(
            lambda: read_file_tool(str(disk_file), task_id=task_id),
            client=client,
            session_id="session-1",
            cwd=tmp_path,
            capabilities=_caps(read=False),
        )

    raw = asyncio.run(run())
    payload = json.loads(raw)
    assert "clean disk" in payload["content"]
    assert client.read_calls == []


@pytest.mark.asyncio
async def test_write_uses_acp_client_without_local_disk_double_mutation(tmp_path):
    disk_file = tmp_path / "example.txt"
    disk_file.write_text("original disk\n", encoding="utf-8")
    client = FakeACPClient()
    task_id = f"acp-fs-write-{uuid.uuid4()}"

    raw = await _with_acp_context(
        lambda: write_file_tool(str(disk_file), "editor content\n", task_id=task_id),
        client=client,
        session_id="session-1",
        cwd=tmp_path,
        capabilities=_caps(write=True),
    )

    payload = json.loads(raw)
    assert payload["bytes_written"] == len("editor content\n".encode("utf-8"))
    assert "warning" not in payload
    assert disk_file.read_text(encoding="utf-8") == "original disk\n"
    assert client.write_calls == [
        {
            "content": "editor content\n",
            "path": str(disk_file),
            "session_id": "session-1",
        }
    ]


@pytest.mark.asyncio
async def test_editor_resource_not_found_falls_back_to_local_disk(tmp_path):
    disk_file = tmp_path / "example.txt"
    disk_file.write_text("clean disk\n", encoding="utf-8")
    client = FakeACPClient(fail=RuntimeError("Resource not found"))
    task_id = f"acp-fs-resource-miss-{uuid.uuid4()}"

    raw = await _with_acp_context(
        lambda: read_file_tool(str(disk_file), task_id=task_id),
        client=client,
        session_id="session-1",
        cwd=tmp_path,
        capabilities=_caps(read=True),
    )

    payload = json.loads(raw)
    assert "clean disk" in payload["content"]
    assert "error" not in payload
    assert client.read_calls


@pytest.mark.asyncio
async def test_editor_write_internal_error_falls_back_to_local_disk(tmp_path):
    disk_file = tmp_path / "example.txt"
    disk_file.write_text("original disk\n", encoding="utf-8")
    client = FakeACPClient(fail=RuntimeError("Internal error"))
    task_id = f"acp-fs-write-fallback-{uuid.uuid4()}"

    raw = await _with_acp_context(
        lambda: write_file_tool(str(disk_file), "local fallback\n", task_id=task_id),
        client=client,
        session_id="session-1",
        cwd=tmp_path,
        capabilities=_caps(write=True),
    )

    payload = json.loads(raw)
    assert payload["bytes_written"] == len("local fallback\n".encode("utf-8"))
    assert "error" not in payload
    assert disk_file.read_text(encoding="utf-8") == "local fallback\n"
    assert client.write_calls


@pytest.mark.asyncio
async def test_repeated_acp_read_refetches_dirty_buffer_instead_of_deduping(tmp_path):
    disk_file = tmp_path / "example.txt"
    disk_file.write_text("clean disk\n", encoding="utf-8")
    client = FakeACPClient(read_content="dirty v1\n")
    task_id = f"acp-fs-read-dedup-{uuid.uuid4()}"

    async def run_once():
        return await _with_acp_context(
            lambda: read_file_tool(str(disk_file), offset=1, limit=5, task_id=task_id),
            client=client,
            session_id="session-1",
            cwd=tmp_path,
            capabilities=_caps(read=True),
        )

    first = json.loads(await run_once())
    client.read_content = "dirty v2\n"
    second = json.loads(await run_once())

    assert "dirty v1" in first["content"]
    assert "dirty v2" in second["content"]
    assert second.get("status") != "unchanged"
    assert len(client.read_calls) == 2


@pytest.mark.asyncio
async def test_patch_replace_uses_acp_dirty_buffer_and_write(tmp_path):
    disk_file = tmp_path / "example.txt"
    disk_file.write_text("clean disk old\n", encoding="utf-8")
    client = FakeACPClient(read_content="dirty buffer old\n")
    task_id = f"acp-fs-patch-replace-{uuid.uuid4()}"

    raw = await _with_acp_context(
        lambda: patch_tool(
            mode="replace",
            path=str(disk_file),
            old_string="dirty buffer old",
            new_string="dirty buffer new",
            task_id=task_id,
        ),
        client=client,
        session_id="session-1",
        cwd=tmp_path,
        capabilities=_caps(read=True, write=True),
    )

    payload = json.loads(raw)
    assert payload["success"] is True
    assert "dirty buffer new" in payload["diff"]
    assert disk_file.read_text(encoding="utf-8") == "clean disk old\n"
    assert client.write_calls[-1]["content"] == "dirty buffer new\n"


@pytest.mark.asyncio
async def test_patch_v4a_uses_acp_dirty_buffer_and_write(tmp_path):
    disk_file = tmp_path / "example.txt"
    disk_file.write_text("clean disk old\n", encoding="utf-8")
    client = FakeACPClient(read_content="alpha\nold\nomega\n")
    task_id = f"acp-fs-patch-v4a-{uuid.uuid4()}"
    patch = """*** Begin Patch
*** Update File: example.txt
@@ old @@
 alpha
-old
+new
 omega
*** End Patch
"""

    raw = await _with_acp_context(
        lambda: patch_tool(mode="patch", patch=patch, task_id=task_id),
        client=client,
        session_id="session-1",
        cwd=tmp_path,
        capabilities=_caps(read=True, write=True),
    )

    payload = json.loads(raw)
    assert payload["success"] is True
    assert "new" in payload["diff"]
    assert disk_file.read_text(encoding="utf-8") == "clean disk old\n"
    assert client.write_calls[-1]["content"] == "alpha\nnew\nomega\n"


@pytest.mark.asyncio
async def test_acp_failure_returns_clear_error_without_local_fallback(tmp_path):
    disk_file = tmp_path / "example.txt"
    disk_file.write_text("clean disk\n", encoding="utf-8")
    client = FakeACPClient(fail=RuntimeError("zed unavailable"))
    task_id = f"acp-fs-failure-{uuid.uuid4()}"

    raw = await _with_acp_context(
        lambda: read_file_tool(str(disk_file), task_id=task_id),
        client=client,
        session_id="session-1",
        cwd=tmp_path,
        capabilities=_caps(read=True),
    )

    payload = json.loads(raw)
    assert "ACP editor filesystem read failed" in payload["error"]
    assert "zed unavailable" in payload["error"]
    assert client.read_calls


@pytest.mark.asyncio
async def test_server_stores_client_filesystem_capabilities():
    agent = HermesACPAgent()

    await agent.initialize(client_capabilities=_caps(read=True, write=False))

    assert agent.client_supports_fs_read() is True
    assert agent.client_supports_fs_write() is False
