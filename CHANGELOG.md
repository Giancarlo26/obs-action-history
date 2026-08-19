# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
uses [Semantic Versioning](https://semver.org/).

While the version is below `1.0.0`, tool NAMES may still change between minor
versions. Pin an exact version if you script against them.

## [0.1.0] - 2026-08-18

First release.

### Added

- **Event subscription.** The server identifies with a real event mask
  instead of `0`, handles the event opcode, and keeps a bounded ring buffer.
  `obs_watch` reports what OBS has been doing; `obs_who_is_talking` reduces
  `InputVolumeMeters` - roughly fifty messages a second per source - to a peak
  per source, so the answer is "who is loud", not three thousand frames.
- **67 tools** in eleven modules: scene items, filters, audio routing,
  capture, studio mode, inputs, outputs, media, hotkeys, projectors, plus the
  core scene/stream/record set.
- `obs_input_property_items`, which enumerates the real device identifiers
  behind a source property. Without it an assistant can only adjust sources a
  human already created.
- A fail-safe module registry: a module that is missing, throws, returns a
  malformed tool or duplicates a name is logged and skipped, and the server
  still starts with everything else.

### Notes

- Zero runtime dependencies. Node builtins only.
- Requires Node 22 or newer for the global `WebSocket`.
