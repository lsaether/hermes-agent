"""Tests for git-based Hermes updater behavior.

These use real temporary git repositories because the behavior under test is
history shape preservation: fast-forward vs. rebasing a local commit stack.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from hermes_cli.git_update import (
    GitUpdateError,
    update_checkout_preserving_local_commits,
)


def _git(cwd: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        cwd=cwd,
        check=check,
        capture_output=True,
        text=True,
    )


def _configure_user(repo: Path) -> None:
    _git(repo, "config", "user.email", "hermes-test@example.com")
    _git(repo, "config", "user.name", "Hermes Test")


def _commit_file(repo: Path, relative: str, content: str, message: str) -> str:
    path = repo / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    _git(repo, "add", relative)
    _git(repo, "commit", "-m", message)
    return _git(repo, "rev-parse", "HEAD").stdout.strip()


@pytest.fixture
def git_repos(tmp_path: Path) -> dict[str, Path]:
    """Create origin.git plus a work clone and an upstream-author clone."""
    origin = tmp_path / "origin.git"
    _git(tmp_path, "init", "--bare", "--initial-branch=main", str(origin))

    seed = tmp_path / "seed"
    _git(tmp_path, "clone", str(origin), str(seed))
    _configure_user(seed)
    _commit_file(seed, "README.md", "base\n", "initial")
    _git(seed, "push", "origin", "main")

    work = tmp_path / "work"
    upstream = tmp_path / "upstream"
    _git(tmp_path, "clone", str(origin), str(work))
    _git(tmp_path, "clone", str(origin), str(upstream))
    _configure_user(work)
    _configure_user(upstream)
    return {"origin": origin, "work": work, "upstream": upstream}


def _divergence(repo: Path) -> str:
    return _git(repo, "rev-list", "--left-right", "--count", "origin/main...HEAD").stdout.strip()


def test_fast_forwards_when_no_local_commits_exist(git_repos: dict[str, Path]) -> None:
    work = git_repos["work"]
    upstream = git_repos["upstream"]

    upstream_head = _commit_file(upstream, "upstream.txt", "upstream\n", "upstream change")
    _git(upstream, "push", "origin", "main")
    _git(work, "fetch", "origin")

    result = update_checkout_preserving_local_commits(["git"], work)

    assert result.strategy == "fast_forward"
    assert result.changed is True
    assert result.local_ahead == 0
    assert result.upstream_ahead == 1
    assert result.backup_branch is None
    assert _git(work, "rev-parse", "HEAD").stdout.strip() == upstream_head
    assert _divergence(work) == "0\t0"


def test_rebases_local_commits_when_branch_is_ahead_and_behind(
    git_repos: dict[str, Path],
) -> None:
    work = git_repos["work"]
    upstream = git_repos["upstream"]

    local_old_head = _commit_file(work, "local.txt", "local\n", "local customization")
    _commit_file(upstream, "upstream.txt", "upstream\n", "upstream change")
    _git(upstream, "push", "origin", "main")
    _git(work, "fetch", "origin")
    assert _divergence(work) == "1\t1"

    result = update_checkout_preserving_local_commits(["git"], work)

    assert result.strategy == "rebase"
    assert result.changed is True
    assert result.local_ahead == 1
    assert result.upstream_ahead == 1
    assert result.old_head == local_old_head
    assert result.backup_branch is not None
    assert result.backup_branch.startswith("backup/main-pre-update-")
    assert _git(work, "rev-parse", result.backup_branch).stdout.strip() == local_old_head
    assert _git(work, "rev-list", "--count", "origin/main..HEAD").stdout.strip() == "1"
    assert _divergence(work) == "0\t1"
    assert (work / "local.txt").read_text(encoding="utf-8") == "local\n"
    assert (work / "upstream.txt").read_text(encoding="utf-8") == "upstream\n"


def test_rebase_conflict_aborts_and_leaves_old_head_checked_out(
    git_repos: dict[str, Path],
) -> None:
    work = git_repos["work"]
    upstream = git_repos["upstream"]

    old_head = _commit_file(work, "README.md", "local\n", "local conflicting change")
    _commit_file(upstream, "README.md", "upstream\n", "upstream conflicting change")
    _git(upstream, "push", "origin", "main")
    _git(work, "fetch", "origin")
    assert _divergence(work) == "1\t1"

    with pytest.raises(GitUpdateError) as excinfo:
        update_checkout_preserving_local_commits(["git"], work)

    message = str(excinfo.value)
    assert "Could not rebase local Hermes patches" in message
    assert "backup/main-pre-update-" in message
    assert _git(work, "rev-parse", "HEAD").stdout.strip() == old_head
    assert _git(work, "status", "--porcelain").stdout == ""

    backup_refs = _git(
        work,
        "for-each-ref",
        "--format=%(refname:short)",
        "refs/heads/backup",
    ).stdout.splitlines()
    assert len(backup_refs) == 1
    assert _git(work, "rev-parse", backup_refs[0]).stdout.strip() == old_head


def test_noops_when_only_local_commits_exist(git_repos: dict[str, Path]) -> None:
    work = git_repos["work"]
    local_head = _commit_file(work, "local.txt", "local\n", "local customization")
    _git(work, "fetch", "origin")
    assert _divergence(work) == "0\t1"

    result = update_checkout_preserving_local_commits(["git"], work)

    assert result.strategy == "none"
    assert result.changed is False
    assert result.local_ahead == 1
    assert result.upstream_ahead == 0
    assert result.old_head == local_head
    assert result.new_head == local_head
    assert _divergence(work) == "0\t1"
