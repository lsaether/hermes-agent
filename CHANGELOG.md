# Changelog

All notable changes for this local TUI Remote Bridge branch are documented here.

## Unreleased

### Added
- Started tracking branch changes in `CHANGELOG.md`.
- Added a bounded live display journal for remote/mobile TUI bridge sessions so late-attaching clients can hydrate the same lightweight transcript they would have seen while connected.

### Security
- Restricted the remote bridge to an explicit method allowlist (live session control + read-only/informational methods). Requests for any other method — e.g. `shell.exec`, `cli.exec`, `config.set`, `model.save_key`, `cron.manage`, slash-command execution — are rejected with `4403` before dispatch, so a bridge token cannot reach the host-control, secret, or scheduling surfaces. The local stdio TUI is unaffected; it bypasses the allowlist entirely.

### Fixed
- Fixed mobile reconnect hydration for live TUI sessions: `session.activate` now prefers the live display journal over reduced canonical model history, preserving user prompts, tool start/complete rows, visible status events, and completed assistant messages without mirroring full TUI UI state.
- Made `bridge_transports` copy-on-write so a client attaching mid-turn can no longer race the streaming thread into a `list changed size during iteration` crash.
