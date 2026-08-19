"use strict";
/*
 * Capture - getting a piece of the broadcast out of OBS and onto disk.
 *
 * Everything here is a clip primitive, and they share one shape of failure:
 * the request returns before the file exists. SaveReplayBuffer answers
 * immediately and the write happens afterwards, so a naive wrapper that asks
 * for the filename in the next breath gets the PREVIOUS clip's path and hands
 * it to whatever was going to upload it. This module waits for the path to
 * actually change and tells you if it did not.
 *
 * The other shared failure is preconditions. Four of these five requests need
 * an output that is already running, and obs-websocket reports that as a bare
 * numeric status code - 501 with no comment - which arrives at the model as
 * `code 501` and explains nothing. Each handler translates its own.
 */

/* obs-websocket RequestStatus codes, only the ones this module can provoke. */
const CODE_HELP = {
  500: "an output is already running and has to be stopped first",
  501: "the output is not running - start it before asking it to do anything",
  502: "the output is paused",
  504: "the output is disabled in OBS settings",
  600: "no source by that name",
};

/* The server rejects with `OBS rejected "X": code NNN`, or with OBS's own
 * comment when it supplies one. Pull the number back out and say what it means. */
const explain = (e, extra) => {
  const m = /code (\d+)/.exec(e.message || "");
  const help = m && CODE_HELP[m[1]];
  if (!help) return e;
  return new Error(`${e.message} - ${help}${extra ? `. ${extra}` : ""}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const lastReplayPath = (obs) =>
  obs
    .request("GetLastReplayBufferReplay")
    .then((r) => r.savedReplayPath || null)
    .catch(() => null); // 501 before the buffer has ever saved. Not an error here.

module.exports = (obs) => [
  {
    name: "obs_replay_buffer",
    description:
      "The replay buffer: OBS holding the last N seconds of the show in memory so you can decide " +
      "AFTER something happens that you wanted to keep it. This is the only capture primitive that " +
      "works backwards in time, which makes it the one an automated producer actually needs - by the " +
      "time a moment is recognisable as good, recording it is already too late. " +
      "action 'save' is the interesting one: it writes the buffer to a file and returns the path. " +
      "TRAPS: (1) The save is asynchronous. SaveReplayBuffer returns before the file is written, so " +
      "asking for the filename immediately gives you the PREVIOUS clip. This tool polls until the " +
      "path changes and reports `pathChanged: false` if it never did - do not hand a path onward " +
      "without checking that flag. (2) The buffer only holds its configured window, 20 seconds on " +
      "the reference machine, so 'save that thing from a minute ago' is not a thing that can succeed. (3) Every " +
      "action except status fails with code 501 unless the buffer is already running, and it does not " +
      "start itself - check status first. (4) The buffer is a separate encode from the stream; " +
      "starting it costs CPU that a live broadcast is already using. (5) These requests drive OBS's MAIN " +
      "replay buffer only. The reference machine also had a second replay_buffer output called 'Vertical " +
      "Backtrack' which they do not touch at all - status lists it so you can see it is there.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["status", "start", "stop", "save"],
          description: "'status' is read-only and always safe.",
        },
        waitMs: {
          type: "number",
          description:
            "save only: how long to wait for the file path to change. Default 4000, max 15000.",
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
    handler: async ({ action, waitMs }) => {
      if (action === "start" || action === "stop") {
        try {
          await obs.request(action === "start" ? "StartReplayBuffer" : "StopReplayBuffer");
        } catch (e) {
          throw explain(e);
        }
      }

      if (action === "save") {
        const before = await lastReplayPath(obs);
        try {
          await obs.request("SaveReplayBuffer");
        } catch (e) {
          throw explain(e, "Start the replay buffer first, then wait out its window before saving");
        }

        // Poll rather than trust. The write is not finished when the request
        // returns, and the only observable proof is the path changing.
        const budget = Math.min(15000, Math.max(250, waitMs || 4000));
        const deadline = Date.now() + budget;
        let path = before;
        while (Date.now() < deadline) {
          await sleep(150);
          path = await lastReplayPath(obs);
          if (path && path !== before) break;
        }

        const pathChanged = !!path && path !== before;
        return {
          saved: true,
          pathChanged,
          savedReplayPath: path,
          previousPath: before,
          waitedMs: budget,
          note: pathChanged
            ? "Path changed, so this is the new clip."
            : `The replay path did not change within ${budget} ms. The clip may still be ` +
              "flushing, or the buffer had nothing to write. Do not treat savedReplayPath " +
              "as the new file.",
        };
      }

      const [status, outputs] = await Promise.all([
        obs.request("GetReplayBufferStatus"),
        obs.request("GetOutputList").catch(() => ({})),
      ]);

      const others = (outputs.outputs || [])
        .filter((o) => o.outputKind === "replay_buffer")
        .map((o) => ({ name: o.outputName, active: o.outputActive }));

      return {
        active: status.outputActive,
        lastSavedPath: status.outputActive ? await lastReplayPath(obs) : null,
        replayBufferOutputs: others,
        note:
          others.length > 1
            ? "More than one replay_buffer output exists. start/stop/save here drive OBS's " +
              "main buffer only; the others are not reachable through these requests."
            : undefined,
      };
    },
  },

  {
    name: "obs_virtual_cam",
    description:
      "OBS's virtual webcam output - the program feed presented to the operating system as a camera, " +
      "so Zoom, Discord, a browser or a second OBS can consume it. " +
      "Safe to touch during a live broadcast: it is a separate output and starting or stopping it " +
      "changes nothing that viewers see, unlike the stream and record controls. " +
      "TRAP: prefer 'start' and 'stop' over 'toggle'. Toggle is the single most common way an " +
      "automated caller turns the virtual camera OFF while meaning to turn it on - it acts on a state " +
      "it did not check, and it returns the state it produced rather than the one you wanted. " +
      "'status' is read-only; it reports only whether the output is active, not who is consuming it, " +
      "so a running virtual camera with nobody watching looks identical to a working one.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["status", "start", "stop", "toggle"],
          description: "'status' is read-only. Use start/stop rather than toggle in automation.",
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
    handler: async ({ action }) => {
      const map = {
        start: "StartVirtualCam",
        stop: "StopVirtualCam",
        toggle: "ToggleVirtualCam",
      };
      if (map[action]) {
        try {
          await obs.request(map[action]);
        } catch (e) {
          throw explain(e);
        }
      }
      const r = await obs.request("GetVirtualCamStatus");
      return {
        active: r.outputActive,
        action,
        note:
          action === "toggle"
            ? "Toggled blind. The `active` value above is the result, not necessarily the intent."
            : undefined,
      };
    },
  },

  {
    name: "obs_save_screenshot",
    description:
      "Write a frame of a scene or source straight to a file on disk, and return the path. " +
      "Use this instead of the image-returning screenshot tool whenever the picture is for a FILE - " +
      "a thumbnail, a clip poster, a before/after pair, anything sampled on a loop. That tool base64s " +
      "the whole image back through the conversation, which for a 1080p frame is megabytes of context " +
      "spent on something nobody is going to look at. This one costs a path. Keep using the other one " +
      "when you personally need to SEE the frame to judge framing or spot a black camera. " +
      "TRAPS: (1) OBS writes the file itself, so imageFilePath is resolved on the machine running OBS, " +
      "not wherever this MCP server lives, and it must be absolute. Point it at a directory that " +
      "already exists. (2) imageWidth and imageHeight are 'scale to inner' - the aspect ratio is kept " +
      "and the smaller ratio wins, so passing both does not crop, it fits. Pass one, or neither for " +
      "native resolution. (3) imageFormat must be one this OBS build compiled in; png, jpg and webp " +
      "are the safe ones, and GetVersion's supportedImageFormats is the real list. (4) A source that " +
      "is not currently rendering gives you a black or stale frame, not an error.",
    inputSchema: {
      type: "object",
      properties: {
        sourceName: {
          type: "string",
          description: "Scene or source name. The current program scene captures what viewers see.",
        },
        imageFilePath: {
          type: "string",
          description:
            "Absolute path ON THE OBS MACHINE, with extension, e.g. /path/to/frame.png (or C:/path/to/frame.png on Windows)",
        },
        imageFormat: {
          type: "string",
          enum: ["png", "jpg", "jpeg", "webp", "bmp", "tiff"],
          description: "Default png. Use jpg or webp for anything sampled repeatedly.",
        },
        imageWidth: { type: "number", minimum: 8, maximum: 4096, description: "Optional. 8-4096." },
        imageHeight: { type: "number", minimum: 8, maximum: 4096, description: "Optional. 8-4096." },
        imageCompressionQuality: {
          type: "number",
          minimum: -1,
          maximum: 100,
          description: "0 = smallest file, 100 = uncompressed, -1 = OBS default. Default -1.",
        },
      },
      required: ["sourceName", "imageFilePath"],
      additionalProperties: false,
    },
    handler: async ({
      sourceName,
      imageFilePath,
      imageFormat,
      imageWidth,
      imageHeight,
      imageCompressionQuality,
    }) => {
      const data = {
        sourceName,
        imageFilePath,
        imageFormat: imageFormat || "png",
      };
      if (imageWidth !== undefined) data.imageWidth = imageWidth;
      if (imageHeight !== undefined) data.imageHeight = imageHeight;
      if (imageCompressionQuality !== undefined)
        data.imageCompressionQuality = imageCompressionQuality;

      try {
        await obs.request("SaveSourceScreenshot", data);
      } catch (e) {
        throw explain(
          e,
          "Check that the source name exists and that the directory in imageFilePath " +
            "exists on the OBS machine"
        );
      }
      return {
        sourceName,
        imageFilePath,
        imageFormat: data.imageFormat,
        note: "OBS reported the write succeeded. The file is on the OBS machine, not necessarily on this one.",
      };
    },
  },

  {
    name: "obs_record_chapter",
    description:
      "Drop a named chapter marker into the local recording at this instant, so the VOD can be " +
      "navigated later without anyone scrubbing through six hours of it. This is the cheap version of " +
      "clipping: it costs nothing, it cannot fail loudly mid-show, and it turns one long recording " +
      "into something with an index. " +
      "TRAPS: (1) Recording must be ACTIVE. Streaming is not recording, and a rig can be live for " +
      "hours with no recording file open at all; in that state this fails with code 501. Check " +
      "obs_record_control status first. (2) Chapters only exist in Hybrid MP4. Any other container " +
      "and the marker goes nowhere; OBS 30.2 onward supports no other format for this. The reference machine " +
      "records hybrid_mp4, so it works here. (3) The marker lands where the recording is NOW, which " +
      "is the live edge - you cannot chapter something that already happened. Name it for what is " +
      "starting, not for what just ended.",
    inputSchema: {
      type: "object",
      properties: {
        chapterName: {
          type: "string",
          description:
            "Optional name. Omit and OBS numbers it. Name it for the segment that starts here.",
        },
      },
      additionalProperties: false,
    },
    handler: async ({ chapterName }) => {
      const data = {};
      if (chapterName !== undefined) data.chapterName = chapterName;
      try {
        await obs.request("CreateRecordChapter", data);
      } catch (e) {
        throw explain(
          e,
          "Chapters need an active recording in a Hybrid MP4 container"
        );
      }
      const status = await obs.request("GetRecordStatus").catch(() => ({}));
      return {
        chapterName: chapterName || "(unnamed - OBS numbered it)",
        atTimecode: status.outputTimecode,
        note: "Only Hybrid MP4 recordings carry chapters. If the container is anything else the marker does not exist in the file.",
      };
    },
  },

  {
    name: "obs_record_split",
    description:
      "Close the recording file being written right now and immediately start the next one, without " +
      "stopping the recording. Use it to cut a long show into pieces you can upload or hand off while " +
      "the show is still going, rather than waiting six hours for one enormous file. " +
      "The stream is untouched - this is the local recording only, and viewers see nothing. " +
      "TRAPS: (1) Recording must be active; otherwise code 501. Streaming being live is not enough - " +
      "the local recording is a separate output. (2) There is no 'undo' and no way to " +
      "rejoin the halves afterwards without re-encoding. (3) The new file is named by OBS's filename " +
      "formatting, so you do not choose the name here - read it back from obs_record_control status " +
      "if you need it. (4) A split is a real container boundary: anything that was mid-chapter or " +
      "mid-scene at that instant is split across two files.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => {
      try {
        await obs.request("SplitRecordFile");
      } catch (e) {
        throw explain(e, "Splitting needs a recording that is already running");
      }
      const status = await obs.request("GetRecordStatus").catch(() => ({}));
      return {
        split: true,
        recordingActive: status.outputActive,
        timecode: status.outputTimecode,
        note: "OBS chose the new filename from its own filename formatting; this request cannot set it.",
      };
    },
  },
];
