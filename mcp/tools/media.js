"use strict";
/*
 * Media inputs - playback state, seeking, transport.
 *
 * WHY THIS MODULE IS NOT A 1:1 WRAPPER
 *
 * The interesting question about a media source is never "what does
 * GetMediaInputStatus return for this one name". It is "is anything actually
 * playing, anywhere". On the reference machine that question has a price attached:
 *
 * The background music is a plain ffmpeg_source called a looping media source, driven by
 * music/player.js, which queues the next track when OBS fires
 * MediaInputPlaybackEnded. When that process's websocket died, the event could
 * no longer arrive, the queue stopped advancing - and the process stayed alive.
 * The supervisor showed green, the panel showed green, and the music was
 * silent for seventeen hours. The one signal that would have caught it was
 * mediaState going ENDED while everything else looked healthy.
 *
 * So obs_media_status defaults to surveying EVERY media input rather than
 * demanding a name, and can take a second sample to prove the cursor is
 * actually moving. Measured on the reference machine while live, all five media inputs
 * reported OBS_MEDIA_STATE_PLAYING and only the cursor told them apart: four
 * advanced ~2550 ms over a 2500 ms window, and a disconnected phone feed sat at
 * mediaCursor 0 and moved not at all. PLAYING is a claim; a moving cursor is
 * evidence.
 */

const MEDIA_KINDS = /^(ffmpeg_source|vlc_source)$/;

const ACTIONS = {
  play: "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY",
  pause: "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE",
  stop: "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP",
  restart: "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART",
  next: "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_NEXT",
  previous: "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PREVIOUS",
};

// inputName and inputUuid are both optional in the protocol; send only what
// the caller gave, so OBS's own "missing field" error survives intact.
const target = ({ inputName, inputUuid }) => {
  const t = {};
  if (inputName !== undefined) t.inputName = inputName;
  if (inputUuid !== undefined) t.inputUuid = inputUuid;
  return t;
};

const shortState = (s) => String(s || "").replace("OBS_MEDIA_STATE_", "").toLowerCase();

/*
 * A live SRT/RTMP feed reports mediaDuration as INT64_MIN, not null - the
 * protocol's "null if not playing" does not cover the unbounded case. Anything
 * that computes a progress percentage without this check produces nonsense.
 */
const finiteDuration = (d) => (typeof d === "number" && d > 0 ? d : null);

function describe(inputName, st) {
  const durationMs = finiteDuration(st.mediaDuration);
  return {
    inputName,
    state: shortState(st.mediaState),
    mediaState: st.mediaState,
    cursorMs: st.mediaCursor,
    durationMs,
    unboundedDuration: durationMs === null && typeof st.mediaDuration === "number" && st.mediaDuration < 0,
  };
}

module.exports = (obs) => [
  {
    name: "obs_media_status",
    description:
      "Survey what media sources are actually playing. With no inputName it checks EVERY media input " +
      "(ffmpeg_source and vlc_source) in one go, which is the form you almost always want: the failure " +
      "worth catching is 'one of them quietly ended', and you cannot spot that by asking about a source " +
      "you already suspect.\n\n" +
      "THE TRAP: mediaState PLAYING does not mean video or audio is arriving. A disconnected SRT feed sits " +
      "at PLAYING with its cursor frozen at 0 forever - measured on the reference machine, every media input claimed " +
      "PLAYING and only the cursor separated the working ones from a dead feed. Pass probeMs (e.g. 2000) to " +
      "take a second sample and get advancing:true/false " +
      "per source, computed from whether cursorMs actually moved. That is the only honest liveness test.\n\n" +
      "Why it matters here: background music is an ffmpeg_source named a looping media source whose next track is queued by a " +
      "Node process listening for MediaInputPlaybackEnded. When that listener dies the source parks in " +
      "state 'ended' and every other indicator - process table, supervisor, dashboard - stays green. That " +
      "gap once hid seventeen hours of silence. state:'ended' on a looping media source is the whole diagnosis.\n\n" +
      "Note durationMs is null for live feeds: OBS returns INT64_MIN, not null, for a stream with no end, " +
      "so unboundedDuration:true flags a live source rather than a broken one.",
    inputSchema: {
      type: "object",
      properties: {
        inputName: { type: "string", description: "One media input to check. Omit to survey all of them." },
        inputUuid: { type: "string", description: "UUID instead of a name. Ignored when surveying all." },
        probeMs: {
          type: "number",
          description:
            "Wait this many ms and sample again, reporting advancing:true only if the cursor moved. " +
            "2000 is plenty. 0 (default) does a single sample and cannot tell playing from stalled.",
          minimum: 0,
          maximum: 10000,
        },
      },
      additionalProperties: false,
    },
    handler: async (args = {}) => {
      const { inputName, inputUuid, probeMs = 0 } = args;

      let names;
      if (inputName !== undefined || inputUuid !== undefined) {
        names = null; // single, addressed by whatever the caller supplied
      } else {
        const { inputs = [] } = await obs.request("GetInputList", {});
        names = inputs.filter((i) => MEDIA_KINDS.test(i.inputKind)).map((i) => i.inputName);
        if (!names.length) {
          return { mediaInputs: [], note: "no ffmpeg_source or vlc_source inputs exist in the current scene collection" };
        }
      }

      const sample = async () => {
        if (names === null) {
          const st = await obs.request("GetMediaInputStatus", target(args));
          return [describe(inputName !== undefined ? inputName : inputUuid, st)];
        }
        const out = [];
        for (const n of names) {
          try {
            out.push(describe(n, await obs.request("GetMediaInputStatus", { inputName: n })));
          } catch (e) {
            // One unreadable source must not blank the survey - the whole
            // point is seeing the others.
            out.push({ inputName: n, error: e.message });
          }
        }
        return out;
      };

      const first = await sample();
      if (!probeMs) return { mediaInputs: first, probed: false };

      await new Promise((r) => setTimeout(r, probeMs));
      const second = await sample();

      const byName = new Map(second.map((s) => [s.inputName, s]));
      const merged = first.map((a) => {
        const b = byName.get(a.inputName);
        if (!b || a.error || b.error) return { ...a, ...(b && b.error ? { error: b.error } : {}) };
        const moved = typeof a.cursorMs === "number" && typeof b.cursorMs === "number"
          ? b.cursorMs - a.cursorMs
          : null;
        return {
          ...b,
          cursorDeltaMs: moved,
          // Paused is legitimately not advancing; say so rather than calling it broken.
          advancing: moved === null ? null : moved > 0,
        };
      });

      const stalled = merged.filter((m) => m.advancing === false && m.state !== "paused").map((m) => m.inputName);
      return {
        mediaInputs: merged,
        probed: true,
        probeMs,
        stalled,
        note: stalled.length
          ? `not advancing over ${probeMs} ms: ${stalled.join(", ")} - reporting a state but producing nothing`
          : "every media input advanced its cursor",
      };
    },
  },

  {
    name: "obs_media_seek",
    description:
      "Move the playhead of a media source, either to an absolute position (positionMs) or by a relative " +
      "amount (offsetMs, negative to rewind). Exactly one of the two.\n\n" +
      "There is NO bounds checking, by design of the protocol - seeking past the end does not clamp, and " +
      "seeking a live feed that has no meaningful duration is not a defined operation. Read obs_media_status " +
      "first: if durationMs is null and unboundedDuration is true, this source is a live stream and seeking " +
      "it is meaningless.\n\n" +
      "On the reference machine, do not seek a looping media source to reach the next track. The queue lives in music/player.js, not in " +
      "OBS; running `node music/player.js --next` is the supported skip and keeps the player's state file in " +
      "agreement with what is audible.",
    inputSchema: {
      type: "object",
      properties: {
        inputName: { type: "string", description: "Name of the media input." },
        inputUuid: { type: "string", description: "UUID instead of a name." },
        positionMs: { type: "number", description: "Absolute cursor position in milliseconds. Must be >= 0.", minimum: 0 },
        offsetMs: { type: "number", description: "Relative move in milliseconds; negative rewinds." },
      },
      additionalProperties: false,
    },
    handler: async (args = {}) => {
      const { positionMs, offsetMs } = args;
      const hasAbs = positionMs !== undefined;
      const hasRel = offsetMs !== undefined;
      if (hasAbs === hasRel) {
        throw new Error("give exactly one of positionMs (absolute) or offsetMs (relative)");
      }
      if (args.inputName === undefined && args.inputUuid === undefined) {
        throw new Error("give inputName or inputUuid");
      }

      if (hasAbs) {
        await obs.request("SetMediaInputCursor", { ...target(args), mediaCursor: positionMs });
      } else {
        await obs.request("OffsetMediaInputCursor", { ...target(args), mediaCursorOffset: offsetMs });
      }

      // Read back. A seek that silently did nothing looks identical to one
      // that worked if you only trust the empty success response.
      const st = await obs.request("GetMediaInputStatus", target(args));
      return { applied: hasAbs ? { positionMs } : { offsetMs }, now: describe(args.inputName || args.inputUuid, st) };
    },
  },

  {
    name: "obs_media_control",
    description:
      "Transport control for a media source: play, pause, stop, restart, next, previous.\n\n" +
      "next and previous are PLAYLIST actions. They only do something on a vlc_source, which holds a list " +
      "of files. On an ffmpeg_source - which is every media input on the reference machine, a looping media source included - there is no " +
      "playlist, so they succeed and change nothing. A tool call that returns success while nothing happened " +
      "is worse than an error, so check the returned state.\n\n" +
      "Careful with a looping media source specifically: its watchdog in music/player.js advances the queue on states ended, " +
      "none and error, but NOT on paused or stopped. So pausing or stopping a looping media source here is not self-healing - " +
      "the music stays silent until a person notices, which is the exact failure mode the reference machine already " +
      "paid seventeen hours for. Use `node music/player.js --next` to skip a track instead.",
    inputSchema: {
      type: "object",
      properties: {
        inputName: { type: "string", description: "Name of the media input." },
        inputUuid: { type: "string", description: "UUID instead of a name." },
        action: {
          type: "string",
          enum: ["play", "pause", "stop", "restart", "next", "previous"],
          description: "next/previous are playlist-only and are no-ops on an ffmpeg_source.",
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
    handler: async (args = {}) => {
      const { action } = args;
      if (args.inputName === undefined && args.inputUuid === undefined) {
        throw new Error("give inputName or inputUuid");
      }
      await obs.request("TriggerMediaInputAction", {
        ...target(args),
        mediaAction: ACTIONS[action],
      });

      const st = await obs.request("GetMediaInputStatus", target(args));
      const now = describe(args.inputName || args.inputUuid, st);
      const noop = (action === "next" || action === "previous");
      return {
        action,
        mediaAction: ACTIONS[action],
        now,
        ...(noop ? { warning: "next/previous only apply to vlc_source playlists; on an ffmpeg_source this changed nothing" } : {}),
      };
    },
  },
];
