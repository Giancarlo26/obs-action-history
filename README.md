# obs-action-history

**An MCP server for OBS Studio that can hear.**

There are already several of these. Most of them wrap the obs-websocket
request surface one call at a time and stop there. That is a reasonable thing
to build, and it produces a tool that can operate OBS competently. It also
produces a tool that is, in a specific and consequential way, deaf.

This one subscribes to the event stream, keeps a bounded record of what
happened, and answers questions about it.

Zero dependencies. Node builtins only. Windows, macOS and Linux.

---

## The distinction that matters

A request answers exactly one kind of question: what is true at this instant.
You ask, OBS replies, you decide. Whatever occurred between one call and the
next is gone, and you have no way of knowing it was ever there.

Now, that sounds like an architectural footnote. It is not. Consider what it
costs you.

**There is no request in the obs-websocket protocol that returns an audio
level.** `GetInputVolume` gives you the fader position. `GetInputMute` gives
you a boolean. Neither has anything to say about whether sound is actually
coming out of that microphone. Levels exist in one place only, as
`InputVolumeMeters`, which is an event.

So the question "is my microphone working right now" cannot be answered by a
server built purely on requests. Not answered poorly. Not answered slowly.
Not answered at all. A server exposing 148 tools has precisely the same blind
spot as one exposing twelve, because the answer is not on the surface either
of them is drawn from.

This server holds that stream:

```
obs_who_is_talking  ->  Mic A    peak -36.9 dB   29 samples
                        Mic B    peak -37.8 dB   29 samples
                        Music    peak -54.2 dB   29 samples
```

`InputVolumeMeters` arrives roughly fifty times a second per source. Nobody
wants three thousand raw frames back from a tool call. The question a person
actually has is *who was loud*, so meters never enter the buffer at all. They
are reduced to a peak per source and returned as an answer.

## What this buys you, concretely

**A microphone that is configured correctly and produces nothing.** Fader at
unity, not muted, and the wrong device selected or a cable quietly dead. Every
setting a request can reach reports perfect health. This is not hypothetical;
it is why the rig this came from needed a separate microphone-checking process
before this existed.

**A camera that follows the voice.** You need to know which of two microphones
is louder, continuously, and you need to compare them against each other
rather than against some fixed threshold, because two microphones in one room
have different gains and each of them hears everybody. There is nothing here
to poll. The information only arrives as it happens.

**Something alive and wedged, which is worse than something dead.** During
development this server surveyed five media sources and every one of them
reported `PLAYING`. One had advanced zero milliseconds while the others moved
about 2,540. By state they were indistinguishable. Only elapsed time separated
a working feed from a corpse, and that exact blindness had already concealed
seventeen hours of silent music behind a dashboard showing green.

**What happened two minutes ago.** A poller can describe the present and
nothing else. Once something has passed, it is simply unavailable, and you are
reduced to guessing about the very incident you are trying to explain.

## The descriptions are part of the product

A tool description is not a place to restate the parameter list. The model can
already read the schema. It is where you put the things that will otherwise be
learned the expensive way:

- OBS audio sync offset **caps near 960 ms**. Larger values apply silently as
  nothing, so you believe you compensated for a two second delay and you
  compensated for none of it.
- Scene item **index 0 is the bottom**, and a full-canvas source sitting above
  a background conceals it utterly, with no error raised anywhere.
- A source parked **off-canvas is still visible and still plays its audio**.
  Hiding it instead does cut the audio, which is why an audio-only overlay is
  parked rather than hidden.
- `RemoveInput` reports success and does not delete a source that anything
  still references.
- Bounds fields are inert unless `boundsType` is set first.
- `TriggerHotkeyByName` takes a bare name, and `libobs.mute` is registered
  once per audio source, twenty-four times on the reference machine. Hotkeys
  therefore cannot address a specific source, whatever you might reasonably
  assume.

Each of those cost somebody something. They are written down because a model
that does not know them will act confidently and be wrong, which is a good
deal worse than acting tentatively and being right.

## The tool that makes a fresh machine possible

`obs_input_property_items` enumerates the real choices behind a source
property: every webcam and every audio device, with the identifiers OBS
actually expects.

```
Microphone (Some USB Mic)
  -> {0.0.1.00000000}.{xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx}
```

There is nothing human-readable in that to guess at. Without this call, an
assistant can only adjust sources a person already created by hand. With it,
it can build them from nothing.

## What is covered

67 tools across eleven modules.

| Module | What it reaches |
|---|---|
| scene items | add, remove, duplicate, z-order, lock, blend, the full fifteen-field transform |
| filters | complete CRUD, reordering, renaming, and every filter kind the install can create |
| audio routing | monitor type, sync offset, track assignment, balance, special inputs |
| capture | replay buffer including save, virtual camera, screenshot to disk, record chapters, file splitting |
| studio mode | preview scene, and the transition that puts it to air |
| inputs | device enumeration, properties buttons, remove, rename, kind reference |
| outputs | enumerate, status, settings, start and stop |
| media | transport control, and a status probe that reports cursor movement |
| hotkeys | list and trigger, the only route to plugin features that have no request of their own |
| projectors | monitors, and fullscreen output of a mix or a single source |
| core | scenes, sources, streaming, recording, screenshots, and a raw escape hatch |

## Install

You need **Node 22 or newer**, for the global WebSocket, and OBS 31+ with
*Tools → WebSocket Server Settings → Enable WebSocket server* ticked.

Copy `.mcp.example.json` into your MCP client's configuration and point `args`
at `server.js`. The password is read from `OBS_WEBSOCKET_PASSWORD` when it is
set, and otherwise from a `secrets.json` beside the server:

```json
{ "obsPassword": "the value from OBS > Tools > WebSocket Server Settings" }
```

Be aware that a wrong password does not present as a wrong password. OBS
accepts the socket and then closes it with code 4009, which most clients
report as a timeout, and you will spend your afternoon investigating your
network. This server names it correctly.

## The reference machine

Figures quoted throughout, such as the 43 filter kinds, the 411 hotkeys of
which only 88 are distinct, the 960 ms ceiling, the five outputs and two
replay buffers, were measured on **OBS 32.2.1 with obs-websocket 5.7.4 on
Windows**, while that machine was broadcasting live to three platforms. That
is what *the reference machine* refers to wherever it appears. Your install
will differ in places, and every one of those numbers is checkable with the
tools here, which is the point of stating them rather than rounding them off
into vagueness.

Two errors in the published obs-websocket documentation surfaced this way and
are worked around. `GetSourceFilterKindList` returns `sourceFilterKinds`,
where the documentation says `filterKinds`. And `SetSourceFilterSettings.overlay`
defaults to **true**, where a summary claimed false; passing false calls
`obs_source_reset_settings` and destroys every other tuned value on that
filter, which is the sort of mistake you make once.

## Contributing

`mcp/tools/index.js` holds the contract. A module exports
`(obs) => [ { name, description, inputSchema, handler } ]` and may use
`obs.request(type, data)` and nothing else.

Loading is deliberately fail-safe. A module that is missing, that throws while
building, that returns a malformed tool or that duplicates a name is logged
and skipped, and the server still starts with everything else intact. Your
broken module is your problem and should not become somebody else's dead
broadcast.

Before you open a pull request:

```bash
npm run preflight
```

It refuses credentials, absolute paths, machine-specific addresses and device
identifiers anywhere in the tree, and it verifies that every module still
loads.

## Status

`0.1.0`. Tool **names** may still move before 1.0. Pin an exact version if you
are scripting against them.

## Licence

MIT. See [LICENSE](LICENSE).
