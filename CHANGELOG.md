# Changelog

All notable changes to this plugin are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/).

## [0.1.0] — 2026-11-24

### Added

- A workspace picker dialog that opens whenever a new DSH conversation would start:
  `Ctrl+N`, the sidebar **New session** row, the expanded brand mark, and the `+`
  buttons of sidebar-replacing plugins.
- Existing-workspace selection with the current workspace preselected.
- New-workspace form: name defaults to today's date (`YYYY-MM-DD`) and is editable,
  parent folder defaults to the current workspace's parent (or the last folder used),
  with a **Browse…** button and a live preview of the resulting path.
- Host routes `POST /dsh-new-session-workspace/prepare` and
  `POST /dsh-new-session-workspace/home`, because the Windows/macOS Desktop folder
  picker exposes only `pick()` while `workspaceRegistry.create()` refuses paths that
  do not exist yet.
- Plugin-manager metadata in `en` and `zh`, a raster icon, and long-form docs.
