"""Git checkout update helpers for ``hermes update``.

This module intentionally contains the history-shaping part of the updater so
``hermes_cli.main`` can stay focused on orchestration: prompts, dependency
installation, skill sync, gateway restart, and config migration.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
import re
import subprocess
from typing import Literal, Sequence

UpdateStrategy = Literal["none", "fast_forward", "rebase"]


@dataclass(frozen=True)
class GitUpdateResult:
    """Summary of a git checkout update attempt."""

    changed: bool
    strategy: UpdateStrategy
    backup_branch: str | None
    local_ahead: int
    upstream_ahead: int
    old_head: str
    new_head: str


class GitUpdateError(RuntimeError):
    """Raised when the git update cannot be completed safely."""

    def __init__(self, message: str, *, backup_branch: str | None = None) -> None:
        super().__init__(message)
        self.backup_branch = backup_branch


def update_checkout_preserving_local_commits(
    git_cmd: Sequence[str],
    cwd: Path,
    *,
    branch: str = "main",
    upstream_ref: str = "origin/main",
) -> GitUpdateResult:
    """Update a git checkout while preserving local commits.

    ``hermes update`` fetches ``origin`` before calling this helper. The helper
    then picks one of three low-risk strategies:

    - no upstream commits: do nothing, even if local commits exist;
    - no local commits: fast-forward from ``upstream_ref``;
    - local commits + upstream commits: create a backup branch and rebase the
      local commit stack onto ``upstream_ref``.

    On rebase conflict, the rebase is aborted before raising so the checkout is
    returned to its pre-update commit. The backup branch remains as an explicit
    recovery anchor.
    """

    cwd = Path(cwd)
    old_head = _git_stdout(git_cmd, cwd, ["rev-parse", "HEAD"])
    upstream_ahead, local_ahead = _divergence(git_cmd, cwd, upstream_ref)

    if upstream_ahead == 0:
        return GitUpdateResult(
            changed=False,
            strategy="none",
            backup_branch=None,
            local_ahead=local_ahead,
            upstream_ahead=upstream_ahead,
            old_head=old_head,
            new_head=old_head,
        )

    if local_ahead == 0:
        print("→ Fast-forwarding local checkout...")
        _run_or_raise(
            git_cmd,
            cwd,
            ["pull", "--ff-only", "origin", branch],
            "Could not fast-forward Hermes checkout from origin/main.",
        )
        new_head = _git_stdout(git_cmd, cwd, ["rev-parse", "HEAD"])
        return GitUpdateResult(
            changed=True,
            strategy="fast_forward",
            backup_branch=None,
            local_ahead=local_ahead,
            upstream_ahead=upstream_ahead,
            old_head=old_head,
            new_head=new_head,
        )

    print(f"→ Local commit stack detected: {local_ahead} commit(s)")
    backup_branch = _create_backup_branch(git_cmd, cwd, branch, old_head)
    print(f"  ✓ Backup branch: {backup_branch}")
    print(f"→ Rebasing local commits onto {upstream_ref}...")

    rebase = _run(git_cmd, cwd, ["rebase", upstream_ref])
    if rebase.returncode != 0:
        abort = _run(git_cmd, cwd, ["rebase", "--abort"])
        abort_note = ""
        if abort.returncode != 0:
            abort_note = (
                "\n  ⚠ Automatic `git rebase --abort` also failed; "
                "inspect the checkout before continuing."
            )
        details = _first_nonempty_line(rebase.stderr) or _first_nonempty_line(rebase.stdout)
        detail_line = f"\n  Git said: {details}" if details else ""
        raise GitUpdateError(
            "✗ Could not rebase local Hermes patches onto origin/main."
            f"{detail_line}\n"
            "  Your local commits are preserved."
            f"\n  Backup branch: {backup_branch}"
            f"{abort_note}\n"
            "  Retry manually with:\n"
            "    cd ~/.hermes/hermes-agent\n"
            f"    git rebase {upstream_ref}",
            backup_branch=backup_branch,
        )

    new_head = _git_stdout(git_cmd, cwd, ["rev-parse", "HEAD"])
    print("  ✓ Rebased local commits successfully")
    return GitUpdateResult(
        changed=True,
        strategy="rebase",
        backup_branch=backup_branch,
        local_ahead=local_ahead,
        upstream_ahead=upstream_ahead,
        old_head=old_head,
        new_head=new_head,
    )


def _run(
    git_cmd: Sequence[str], cwd: Path, args: Sequence[str]
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [*git_cmd, *args],
        cwd=cwd,
        capture_output=True,
        text=True,
    )


def _run_or_raise(
    git_cmd: Sequence[str], cwd: Path, args: Sequence[str], message: str
) -> subprocess.CompletedProcess[str]:
    result = _run(git_cmd, cwd, args)
    if result.returncode != 0:
        details = _first_nonempty_line(result.stderr) or _first_nonempty_line(result.stdout)
        detail_line = f"\n  Git said: {details}" if details else ""
        raise GitUpdateError(f"✗ {message}{detail_line}")
    return result


def _git_stdout(git_cmd: Sequence[str], cwd: Path, args: Sequence[str]) -> str:
    return _run_or_raise(git_cmd, cwd, args, f"Git command failed: {' '.join(args)}").stdout.strip()


def _divergence(git_cmd: Sequence[str], cwd: Path, upstream_ref: str) -> tuple[int, int]:
    output = _git_stdout(
        git_cmd,
        cwd,
        ["rev-list", "--left-right", "--count", f"{upstream_ref}...HEAD"],
    )
    parts = output.split()
    if len(parts) != 2:
        raise GitUpdateError(
            "✗ Could not read Hermes git divergence.\n"
            f"  Expected two counts from git; got: {output!r}"
        )
    try:
        upstream_ahead, local_ahead = (int(parts[0]), int(parts[1]))
    except ValueError as exc:
        raise GitUpdateError(
            "✗ Could not parse Hermes git divergence.\n"
            f"  Git returned: {output!r}"
        ) from exc
    return upstream_ahead, local_ahead


def _create_backup_branch(
    git_cmd: Sequence[str], cwd: Path, branch: str, old_head: str
) -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    safe_branch = _safe_ref_component(branch) or "main"
    base = f"backup/{safe_branch}-pre-update-{stamp}"
    for candidate in _candidate_branch_names(base):
        if _branch_exists(git_cmd, cwd, candidate):
            continue
        _run_or_raise(
            git_cmd,
            cwd,
            ["branch", candidate, old_head],
            f"Could not create backup branch {candidate}.",
        )
        return candidate
    raise GitUpdateError("✗ Could not find an unused backup branch name.")


def _candidate_branch_names(base: str):
    yield base
    for index in range(2, 100):
        yield f"{base}-{index}"


def _branch_exists(git_cmd: Sequence[str], cwd: Path, branch: str) -> bool:
    result = _run(git_cmd, cwd, ["show-ref", "--verify", "--quiet", f"refs/heads/{branch}"])
    return result.returncode == 0


def _safe_ref_component(value: str) -> str:
    value = value.strip().strip("/")
    value = re.sub(r"[^A-Za-z0-9._/-]+", "-", value)
    value = re.sub(r"/+/", "/", value)
    value = re.sub(r"\.lock(?:/|$)", "-lock/", value)
    return value.strip("./")


def _first_nonempty_line(text: str) -> str:
    for line in text.splitlines():
        stripped = line.strip()
        if stripped:
            return stripped
    return ""
