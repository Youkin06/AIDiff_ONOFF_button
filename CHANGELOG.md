# Changelog

## 1.0.6

- Added a **Git Diff** mode to the Session panel, switchable via a segmented toggle ("AI Diff | Git Diff"). The same tree view, but diffs are computed against the current git `HEAD` instead of the last-accepted AI snapshot — showing every uncommitted change (staged, unstaged, and untracked).
- Git Diff mode: `Open diff` opens a split view of `HEAD` vs the working file; per-file `✓` marks a file as reviewed (hides it), `✗` discards changes (`git checkout HEAD -- <file>`); bulk `Mark All Reviewed` / `Discard All`.

## 1.0.5

- Fix: `Install / Reinstall CLI hooks` no longer wipes other Claude Code hooks (`Stop`, `UserPromptSubmit`, `SessionStart`, etc.) or unrelated `PreToolUse` / `PostToolUse` entries from `~/.claude/settings.json`. Existing hooks are preserved; only previous copies of this extension's hooks are replaced.

## 1.0.3

- Added hero screenshot to the README and the marketplace listing.

## 1.0.2

- Rewritten README with badges, feature table, configuration, commands, keybindings, and an upstream comparison.
- Tighter marketplace description.
- Gallery banner colour set for the marketplace listing.

## 1.0.1

- Icon refresh.

## 1.0.0 — Initial fork release

Forked from [konan-1947/ai-cli-diff-view](https://github.com/konan-1947/claude_diff_view_vscode_extension) at upstream `v1.0.12`.

### Added

- Setting `ai-cli-diff-view.autoOpenDiffEditor` (default: `false`) — controls whether the split-view diff editor opens automatically when an AI CLI edits a file.
- In-panel toggle for the auto-open behaviour, mirrors the setting above.
- Command `AI Diff: Open Pending File (Editor)` — opens a pending file in a normal editor with inline highlights, no diff editor.
- Session panel: hover-only `Open file` / `Open diff` buttons on each pending file row.
- Session panel: hover-only per-file `Accept` / `Revert` (`✓` / `✗`) actions.
- Session panel: `Accept All` / `Revert All` bulk buttons above the pending list.

### Changed

- Clicking a row in the Session panel no longer auto-opens the diff editor — all opening actions are now explicit.
- Switching the active editor to a file with a pending diff no longer force-opens the diff editor (was the source of the close-then-reopen loop).
- All manual entry points (`Open Pending File`, Alt+H/L navigation, "next file after accept") pass `force=true` to `openDiff` so they always show the split-view regardless of the auto-open setting.
- Command titles in the palette: `AI CLI Diff: …` → `AI Diff: …`.

### Internal

- `DiffManager.openDiff(filePath, force = false)` — new `force` parameter to distinguish manual vs. automatic invocations.
