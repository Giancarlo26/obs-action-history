"use strict";
/*
 * obs-action-history
 * ------------------
 * Zero-dependency MCP (Model Context Protocol) server that lets Claude drive
 * OBS Studio through the built-in obs-websocket v5 protocol.
 *
 * No npm install. No node_modules. Nothing to break mid-production.
 *   - MCP stdio transport  -> implemented directly (newline-delimited JSON-RPC 2.0)
 *   - obs-websocket v5     -> implemented directly (global WebSocket, Node 22+)
 *   - SHA256 auth handshake-> node:crypto (built in)
 *
 * Env:
 *   OBS_WEBSOCKET_URL       default ws://127.0.0.1:4455
 *   OBS_WEBSOCKET_PASSWORD  optional; secrets.json is the normal source
 */

const crypto = require("crypto");
const obsPassword = require("./lib/obs-secret");

const OBS_URL = process.env.OBS_WEBSOCKET_URL || "ws://127.0.0.1:4455";

// This was the ONE OBS client that never got the secrets.json refactor, so its
// password lived in plaintext in .mcp.json - which sits under OneDrive and is
// therefore synced to the cloud. lib/obs-secret still checks the environment
// first, so an env var keeps working; it just is no longer required.
// Empty string rather than a throw: the server must start so it can REPORT the
// missing password through MCP, instead of dying before Claude can be told.
const log = (...a) => process.stderr.write(`[obs-mcp] ${a.join(" ")}\n`);

let OBS_PASSWORD = "";
try {
  OBS_PASSWORD = obsPassword();
} catch (e) {
  log("no OBS password found:", e.message.split("\n")[0]);
}
const SERVER_NAME = "obs-action-history";
const SERVER_VERSION = "1.0.0";


/* ------------------------------------------------------------------ *
 * obs-websocket v5 client
 * ------------------------------------------------------------------ */
class ObsClient {
  constructor(url, password) {
    this.url = url;
    this.password = password;
    this.ws = null;
    this.ready = false;
    this.pending = new Map();
    this.seq = 0;
    this.connecting = null;
    this.obsVersion = null;

    /*
     * Recent events, newest last, bounded.
     *
     * Bounded because meters alone are ~50 messages a second: an unbounded
     * log would be a memory leak in a server that stays up for a whole
     * broadcast day. Meters are kept separately and pre-reduced to a peak per
     * source, because nobody wants 3,000 raw meter frames - the question is
     * always "who was loud", not "what was every sample".
     */
    this.events = [];
    this.eventCap = 400;
    this.meters = new Map();     // sourceName -> { peakDb, lastDb, at, n }
    this.eventCounts = new Map();
  }

  recordEvent(type, data) {
    this.eventCounts.set(type, (this.eventCounts.get(type) || 0) + 1);

    if (type === "InputVolumeMeters") {
      const now = Date.now();
      for (const it of data.inputs || []) {
        const name = it.inputName;
        // Channel arrays are [magnitude, peak, peakHold]; index 1 is the peak.
        // A muted or idle source reports -infinity, which must not become the
        // running maximum.
        let db = -Infinity;
        for (const ch of it.inputLevelsMul || []) {
          const mul = Array.isArray(ch) ? (ch[1] ?? ch[0]) : ch;
          if (typeof mul === "number" && mul > 0) db = Math.max(db, 20 * Math.log10(mul));
        }
        if (!Number.isFinite(db)) continue;
        const cur = this.meters.get(name) || { peakDb: -Infinity, lastDb: -Infinity, at: 0, n: 0 };
        cur.peakDb = Math.max(cur.peakDb, db);
        cur.lastDb = db;
        cur.at = now;
        cur.n++;
        this.meters.set(name, cur);
      }
      return;                    // meters never enter the ring buffer
    }

    this.events.push({ at: Date.now(), type, data });
    if (this.events.length > this.eventCap) this.events.splice(0, this.events.length - this.eventCap);
  }

  resetMeters() { this.meters = new Map(); }

  connect() {
    if (this.ready) return Promise.resolve();
    if (this.connecting) return this.connecting;

    this.connecting = new Promise((resolve, reject) => {
      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true;
        this.connecting = null;
        err ? reject(err) : resolve();
      };

      const timer = setTimeout(
        () => done(new Error(`Timed out connecting to OBS at ${this.url}`)),
        8000
      );

      let ws;
      try {
        ws = new WebSocket(this.url);
      } catch (e) {
        clearTimeout(timer);
        return done(new Error(`Cannot open WebSocket: ${e.message}`));
      }
      this.ws = ws;

      ws.addEventListener("error", () => {
        clearTimeout(timer);
        this.ready = false;
        done(
          new Error(
            `Could not reach OBS at ${this.url}. Check that OBS is running and ` +
              `Tools > WebSocket Server Settings > "Enable WebSocket server" is ticked.`
          )
        );
      });

      ws.addEventListener("close", () => {
        this.ready = false;
        this.ws = null;
        for (const [, p] of this.pending) p.reject(new Error("OBS connection closed"));
        this.pending.clear();
        clearTimeout(timer);
        done(new Error("OBS connection closed during handshake"));
      });

      ws.addEventListener("message", (ev) => {
        let msg;
        try {
          msg = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
        } catch {
          return;
        }

        // op 0 = Hello
        if (msg.op === 0) {
          const d = msg.d || {};
          this.obsVersion = d.obsWebSocketVersion;
          /*
           * Subscribe to events instead of 0.
           *
           * `eventSubscriptions: 0` meant Claude could act on OBS but never
           * react to it - no scene changes, no mute changes, no media ending,
           * and above all no InputVolumeMeters. That single zero is why
           * "switch to whoever is talking" had to become a separate 400-line
           * process with its own port, config file and supervisor entry
           * instead of something the producer could just do.
           *
           * The mask is general+config+scenes+inputs+transitions+filters+
           * outputs+sceneItems+media+vendors+ui, plus meters (1<<16), which
           * sits outside "all" because it is high volume - about 50 messages
           * a second. Events land in a bounded ring buffer, so a long-running
           * session cannot grow memory; obs_watch reads that buffer.
           */
          const SUB_ALL = (1 << 11) - 1;
          const SUB_METERS = 1 << 16;
          const identify = {
            rpcVersion: d.rpcVersion || 1,
            eventSubscriptions: SUB_ALL | SUB_METERS,
          };
          if (d.authentication) {
            if (!this.password) {
              clearTimeout(timer);
              return done(
                new Error(
                  "OBS requires a WebSocket password but OBS_WEBSOCKET_PASSWORD is empty. " +
                    "Copy the password from OBS > Tools > WebSocket Server Settings > Show Connect Info."
                )
              );
            }
            const secret = crypto
              .createHash("sha256")
              .update(this.password + d.authentication.salt)
              .digest("base64");
            identify.authentication = crypto
              .createHash("sha256")
              .update(secret + d.authentication.challenge)
              .digest("base64");
          }
          ws.send(JSON.stringify({ op: 1, d: identify }));
          return;
        }

        // op 2 = Identified
        if (msg.op === 2) {
          clearTimeout(timer);
          this.ready = true;
          log(`connected to OBS (obs-websocket ${this.obsVersion})`);
          return done(null);
        }

        // op 5 = Event. There was no branch for this at all, so every event
        // OBS sent was parsed and dropped on the floor.
        if (msg.op === 5) {
          const d = msg.d || {};
          this.recordEvent(d.eventType, d.eventData || {});
          return;
        }

        // op 7 = RequestResponse
        if (msg.op === 7) {
          const d = msg.d || {};
          const p = this.pending.get(d.requestId);
          if (!p) return;
          this.pending.delete(d.requestId);
          const st = d.requestStatus || {};
          if (st.result) p.resolve(d.responseData || {});
          else
            p.reject(
              new Error(
                `OBS rejected "${d.requestType}": ${st.comment || "code " + st.code}`
              )
            );
        }
      });
    });

    return this.connecting;
  }

  async request(requestType, requestData) {
    await this.connect();
    const requestId = `r${++this.seq}`;
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      const timer = setTimeout(() => {
        if (this.pending.delete(requestId))
          reject(new Error(`OBS request "${requestType}" timed out after 15s`));
      }, 15000);
      const settle = (fn) => (v) => {
        clearTimeout(timer);
        fn(v);
      };
      this.pending.set(requestId, { resolve: settle(resolve), reject: settle(reject) });
      try {
        this.ws.send(
          JSON.stringify({ op: 6, d: { requestType, requestId, requestData: requestData || {} } })
        );
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(new Error(`Failed to send to OBS: ${e.message}`));
      }
    });
  }
}

const obs = new ObsClient(OBS_URL, OBS_PASSWORD);

/* ------------------------------------------------------------------ *
 * Tool definitions
 * ------------------------------------------------------------------ */
const S = {
  none: { type: "object", properties: {}, additionalProperties: false },
  str: (name, desc, extra = {}) => ({
    type: "object",
    properties: { [name]: { type: "string", description: desc }, ...extra.props },
    required: [name, ...(extra.required || [])],
    additionalProperties: false,
  }),
};

const TOOLS = [
  {
    name: "obs_who_is_talking",
    description:
      "Listen to the microphones for a moment and report who is actually speaking, loudest first. " +
      "This is the reactive primitive: it answers 'which person should I cut to right now'. " +
      "Returns a peak level in dB per audio source over the sampling window, so compare the sources " +
      "against EACH OTHER rather than against a fixed threshold - the two mics have different gains " +
      "and each usually picks up everyone in the room, so the loudest is the speaker, not whoever crosses a fixed number. " +
      "A source that reports no level at all is muted, on no audio track, or its scene is not live.",
    inputSchema: {
      type: "object",
      properties: {
        forMs: { type: "number", description: "How long to listen. Default 1200. Keep it under ~3000." },
        sources: { type: "array", items: { type: "string" }, description: "Optional: only report these sources." },
      },
      additionalProperties: false,
    },
    handler: async ({ forMs, sources }) => {
      await obs.connect();
      obs.resetMeters();
      await new Promise((r) => setTimeout(r, Math.min(3000, Math.max(200, forMs || 1200))));
      let rows = [...obs.meters.entries()].map(([name, m]) => ({
        source: name,
        peakDb: Math.round(m.peakDb * 10) / 10,
        lastDb: Math.round(m.lastDb * 10) / 10,
        samples: m.n,
      }));
      if (sources && sources.length) rows = rows.filter((r) => sources.includes(r.source));
      rows.sort((a, b) => b.peakDb - a.peakDb);
      return {
        windowMs: Math.min(3000, Math.max(200, forMs || 1200)),
        loudest: rows.length ? rows[0].source : null,
        sources: rows,
        note: rows.length
          ? "Levels are peaks over the window. Compare sources to each other, not to a threshold."
          : "No source reported a level. Nothing is metering: check mutes and audio tracks.",
      };
    },
  },
  {
    name: "obs_watch",
    description:
      "What OBS has been doing: recent events from the live event stream (scene changes, mute and " +
      "visibility changes, media starting and ending, stream and record state, filter changes). " +
      "Use it to see what happened rather than polling for what is true now. Optionally waits first, " +
      "so you can watch for something you are about to trigger. Audio meters are NOT here - they are " +
      "summarised by obs_who_is_talking instead, because they arrive ~50 times a second.",
    inputSchema: {
      type: "object",
      properties: {
        forMs: { type: "number", description: "Wait this long before reporting, to catch what happens next. Default 0." },
        types: { type: "array", items: { type: "string" }, description: "Only these eventType names, e.g. CurrentProgramSceneChanged." },
        limit: { type: "number", description: "Most recent N events. Default 40." },
      },
      additionalProperties: false,
    },
    handler: async ({ forMs, types, limit }) => {
      await obs.connect();
      const since = Date.now();
      if (forMs > 0) await new Promise((r) => setTimeout(r, Math.min(30000, forMs)));
      let evs = obs.events;
      if (forMs > 0) evs = evs.filter((e) => e.at >= since);
      if (types && types.length) evs = evs.filter((e) => types.includes(e.type));
      const out = evs.slice(-(limit || 40));
      return {
        watchedMs: forMs > 0 ? Math.min(30000, forMs) : 0,
        returned: out.length,
        seenSinceStart: Object.fromEntries([...obs.eventCounts.entries()].sort((a, b) => b[1] - a[1])),
        events: out.map((e) => ({ at: new Date(e.at).toISOString(), type: e.type, data: e.data })),
      };
    },
  },
  {
    name: "obs_health",
    description:
      "Full health snapshot: OBS version, active scene, stream/record state, and live stats " +
      "(CPU %, memory, FPS, render lag, encoding lag, skipped and dropped frames). " +
      "Use this first to diagnose anything, and to check whether the machine is keeping up.",
    inputSchema: S.none,
    handler: async () => {
      const [ver, stats, stream, rec, scene] = await Promise.all([
        obs.request("GetVersion"),
        obs.request("GetStats"),
        obs.request("GetStreamStatus"),
        obs.request("GetRecordStatus"),
        obs.request("GetCurrentProgramScene").catch(() => ({})),
      ]);
      const dropPct =
        stream.outputTotalFrames > 0
          ? ((stream.outputSkippedFrames / stream.outputTotalFrames) * 100).toFixed(2)
          : "0.00";
      return {
        obsVersion: ver.obsVersion,
        websocketVersion: ver.obsWebSocketVersion,
        currentScene: scene.currentProgramSceneName || scene.sceneName,
        streaming: {
          active: stream.outputActive,
          reconnecting: stream.outputReconnecting,
          timecode: stream.outputTimecode,
          kbitsPerSec: stream.outputBytes
            ? Math.round((stream.outputBytes * 8) / 1000 / Math.max(1, stream.outputDuration / 1000))
            : 0,
          totalFrames: stream.outputTotalFrames,
          droppedFrames: stream.outputSkippedFrames,
          droppedPercent: dropPct + "%",
        },
        recording: { active: rec.outputActive, timecode: rec.outputTimecode },
        performance: {
          cpuUsage: stats.cpuUsage != null ? stats.cpuUsage.toFixed(1) + "%" : null,
          memoryMB: stats.memoryUsage != null ? Math.round(stats.memoryUsage) : null,
          activeFps: stats.activeFps != null ? stats.activeFps.toFixed(2) : null,
          averageFrameRenderTimeMs: stats.averageFrameRenderTime,
          renderSkippedFrames: stats.renderSkippedFrames,
          renderTotalFrames: stats.renderTotalFrames,
          outputSkippedFrames: stats.outputSkippedFrames,
          outputTotalFrames: stats.outputTotalFrames,
          freeDiskSpaceMB: stats.availableDiskSpace != null ? Math.round(stats.availableDiskSpace) : null,
        },
      };
    },
  },
  {
    name: "obs_list_scenes",
    description: "List every scene, and which one is currently live (program) and previewed.",
    inputSchema: S.none,
    handler: async () => {
      const r = await obs.request("GetSceneList");
      return {
        currentProgramScene: r.currentProgramSceneName,
        currentPreviewScene: r.currentPreviewSceneName,
        scenes: (r.scenes || []).map((s) => s.sceneName).reverse(),
      };
    },
  },
  {
    name: "obs_switch_scene",
    description:
      "Switch the LIVE scene. This is the POV cut. It never interrupts the stream; the encoder " +
      "keeps running and viewers just see the camera change.",
    inputSchema: S.str("sceneName", "Exact scene name, as returned by obs_list_scenes."),
    handler: async ({ sceneName }) => {
      await obs.request("SetCurrentProgramScene", { sceneName });
      return { ok: true, nowLive: sceneName };
    },
  },
  {
    name: "obs_create_scene",
    description: "Create a new empty scene.",
    inputSchema: S.str("sceneName", "Name for the new scene."),
    handler: async ({ sceneName }) => {
      await obs.request("CreateScene", { sceneName });
      return { ok: true, created: sceneName };
    },
  },
  {
    name: "obs_list_sources_in_scene",
    description:
      "List the sources (scene items) inside a scene, with their item IDs, visibility and transform. " +
      "Needed before moving, resizing or hiding anything.",
    inputSchema: S.str("sceneName", "Scene to inspect."),
    handler: async ({ sceneName }) => {
      const r = await obs.request("GetSceneItemList", { sceneName });
      return {
        sceneName,
        items: (r.sceneItems || []).map((i) => ({
          itemId: i.sceneItemId,
          sourceName: i.sourceName,
          visible: i.sceneItemEnabled,
          locked: i.sceneItemLocked,
          transform: i.sceneItemTransform
            ? {
                x: i.sceneItemTransform.positionX,
                y: i.sceneItemTransform.positionY,
                width: i.sceneItemTransform.width,
                height: i.sceneItemTransform.height,
                scaleX: i.sceneItemTransform.scaleX,
                scaleY: i.sceneItemTransform.scaleY,
              }
            : null,
        })),
      };
    },
  },
  {
    name: "obs_set_source_visible",
    description: "Show or hide one source inside a scene (e.g. drop the overlay, hide a camera).",
    inputSchema: {
      type: "object",
      properties: {
        sceneName: { type: "string", description: "Scene containing the source." },
        sceneItemId: { type: "number", description: "Item ID from obs_list_sources_in_scene." },
        visible: { type: "boolean", description: "true = show, false = hide." },
      },
      required: ["sceneName", "sceneItemId", "visible"],
      additionalProperties: false,
    },
    handler: async ({ sceneName, sceneItemId, visible }) => {
      await obs.request("SetSceneItemEnabled", {
        sceneName,
        sceneItemId,
        sceneItemEnabled: visible,
      });
      return { ok: true };
    },
  },
  {
    name: "obs_set_source_transform",
    description:
      "Position and size a source inside a scene, to build picture-in-picture and " +
      "side-by-side layouts. Coordinates are in canvas pixels.",
    inputSchema: {
      type: "object",
      properties: {
        sceneName: { type: "string" },
        sceneItemId: { type: "number" },
        positionX: { type: "number" },
        positionY: { type: "number" },
        scaleX: { type: "number" },
        scaleY: { type: "number" },
        cropLeft: { type: "number" },
        cropRight: { type: "number" },
        cropTop: { type: "number" },
        cropBottom: { type: "number" },
      },
      required: ["sceneName", "sceneItemId"],
      additionalProperties: false,
    },
    handler: async ({ sceneName, sceneItemId, ...t }) => {
      const transform = {};
      for (const k of [
        "positionX",
        "positionY",
        "scaleX",
        "scaleY",
        "cropLeft",
        "cropRight",
        "cropTop",
        "cropBottom",
      ])
        if (t[k] !== undefined) transform[k] = t[k];
      await obs.request("SetSceneItemTransform", { sceneName, sceneItemId, sceneItemTransform: transform });
      return { ok: true, applied: transform };
    },
  },
  {
    name: "obs_list_inputs",
    description:
      "List every input/source in OBS with its kind (video capture device, media source, browser, " +
      "audio input, etc). Use this to see which cameras and mics OBS can actually see.",
    inputSchema: S.none,
    handler: async () => {
      const r = await obs.request("GetInputList");
      return { inputs: (r.inputs || []).map((i) => ({ name: i.inputName, kind: i.inputKind })) };
    },
  },
  {
    name: "obs_get_input_settings",
    description: "Read the full settings object of one input (resolution, device id, URL, file path...).",
    inputSchema: S.str("inputName", "Exact input name."),
    handler: async ({ inputName }) => obs.request("GetInputSettings", { inputName }),
  },
  {
    name: "obs_set_input_settings",
    description:
      "Change settings on an input: swap a webcam's device, change an SRT/RTMP media source URL, " +
      "change resolution or FPS. Pass only the keys you want to change.",
    inputSchema: {
      type: "object",
      properties: {
        inputName: { type: "string" },
        settings: { type: "object", description: "Partial settings object to merge in." },
      },
      required: ["inputName", "settings"],
      additionalProperties: false,
    },
    handler: async ({ inputName, settings }) => {
      await obs.request("SetInputSettings", { inputName, inputSettings: settings, overlay: true });
      return { ok: true };
    },
  },
  {
    name: "obs_create_input",
    description:
      "Create a new source in a scene. Common kinds: 'dshow_input' (USB webcam/capture card), " +
      "'ffmpeg_source' (SRT/RTMP/RTSP network feed or video file), 'browser_source', " +
      "'wasapi_input_capture' (microphone), 'wasapi_output_capture' (desktop audio), " +
      "'text_gdiplus_v3', 'color_source_v3', 'image_source', 'ndi_source' (needs the NDI plugin).",
    inputSchema: {
      type: "object",
      properties: {
        sceneName: { type: "string" },
        inputName: { type: "string" },
        inputKind: { type: "string" },
        inputSettings: { type: "object" },
      },
      required: ["sceneName", "inputName", "inputKind"],
      additionalProperties: false,
    },
    handler: async ({ sceneName, inputName, inputKind, inputSettings }) => {
      const r = await obs.request("CreateInput", {
        sceneName,
        inputName,
        inputKind,
        inputSettings: inputSettings || {},
        sceneItemEnabled: true,
      });
      return { ok: true, sceneItemId: r.sceneItemId };
    },
  },
  {
    name: "obs_list_input_kinds",
    description: "List every source type this OBS install supports (tells you which plugins loaded).",
    inputSchema: S.none,
    handler: async () => obs.request("GetInputKindList"),
  },
  {
    name: "obs_audio_control",
    description:
      "Get or set mute state and volume for an audio input. Volume is in dB (0 = unity, -100 = silence).",
    inputSchema: {
      type: "object",
      properties: {
        inputName: { type: "string" },
        muted: { type: "boolean", description: "Omit to leave unchanged." },
        volumeDb: { type: "number", description: "Omit to leave unchanged. Range -100..26." },
      },
      required: ["inputName"],
      additionalProperties: false,
    },
    handler: async ({ inputName, muted, volumeDb }) => {
      if (muted !== undefined) await obs.request("SetInputMute", { inputName, inputMuted: muted });
      if (volumeDb !== undefined)
        await obs.request("SetInputVolume", { inputName, inputVolumeDb: volumeDb });
      const [m, v] = await Promise.all([
        obs.request("GetInputMute", { inputName }).catch(() => ({})),
        obs.request("GetInputVolume", { inputName }).catch(() => ({})),
      ]);
      return { inputName, muted: m.inputMuted, volumeDb: v.inputVolumeDb };
    },
  },
  {
    name: "obs_stream_control",
    description:
      "Start, stop or query the live stream. Use 'status' freely. Be deliberate with start and stop, because " +
      "stopping ends the broadcast for every viewer on every platform.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["start", "stop", "status"] },
      },
      required: ["action"],
      additionalProperties: false,
    },
    handler: async ({ action }) => {
      if (action === "start") await obs.request("StartStream");
      if (action === "stop") await obs.request("StopStream");
      return obs.request("GetStreamStatus");
    },
  },
  {
    name: "obs_record_control",
    description: "Start, stop, pause, resume or query local recording (your local backup / VOD master).",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["start", "stop", "pause", "resume", "status"] },
      },
      required: ["action"],
      additionalProperties: false,
    },
    handler: async ({ action }) => {
      const map = {
        start: "StartRecord",
        stop: "StopRecord",
        pause: "PauseRecord",
        resume: "ResumeRecord",
      };
      if (map[action]) await obs.request(map[action]);
      return obs.request("GetRecordStatus");
    },
  },
  {
    name: "obs_screenshot",
    description:
      "Capture what a scene or source looks like RIGHT NOW and return it as an image. " +
      "This is how Claude visually verifies framing, layout and that a camera is actually alive " +
      "instead of showing a black frame.",
    inputSchema: {
      type: "object",
      properties: {
        sourceName: {
          type: "string",
          description: "Scene or source name. Use the current program scene to see what viewers see.",
        },
        width: { type: "number", description: "Optional downscale width, default 1280." },
      },
      required: ["sourceName"],
      additionalProperties: false,
    },
    raw: true,
    handler: async ({ sourceName, width }) => {
      const r = await obs.request("GetSourceScreenshot", {
        sourceName,
        imageFormat: "png",
        imageWidth: width || 1280,
      });
      const b64 = String(r.imageData || "").replace(/^data:image\/\w+;base64,/, "");
      return {
        content: [
          { type: "text", text: `Live frame from "${sourceName}":` },
          { type: "image", data: b64, mimeType: "image/png" },
        ],
      };
    },
  },
  {
    name: "obs_video_settings",
    description:
      "Get or set canvas resolution, output resolution and FPS. Changing these requires the stream " +
      "to be stopped.",
    inputSchema: {
      type: "object",
      properties: {
        baseWidth: { type: "number" },
        baseHeight: { type: "number" },
        outputWidth: { type: "number" },
        outputHeight: { type: "number" },
        fpsNumerator: { type: "number" },
        fpsDenominator: { type: "number" },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      if (Object.keys(args).length) await obs.request("SetVideoSettings", args);
      return obs.request("GetVideoSettings");
    },
  },
  {
    name: "obs_profile_and_collection",
    description:
      "List / switch OBS profiles (encoder + streaming settings) and scene collections (scene layouts).",
    inputSchema: {
      type: "object",
      properties: {
        setProfile: { type: "string" },
        setSceneCollection: { type: "string" },
      },
      additionalProperties: false,
    },
    handler: async ({ setProfile, setSceneCollection }) => {
      if (setProfile) await obs.request("SetCurrentProfile", { profileName: setProfile });
      if (setSceneCollection)
        await obs.request("SetCurrentSceneCollection", { sceneCollectionName: setSceneCollection });
      const [p, c] = await Promise.all([
        obs.request("GetProfileList"),
        obs.request("GetSceneCollectionList"),
      ]);
      return {
        currentProfile: p.currentProfileName,
        profiles: p.profiles,
        currentSceneCollection: c.currentSceneCollectionName,
        sceneCollections: c.sceneCollections,
      };
    },
  },
  {
    name: "obs_transition",
    description: "List transitions, or set the active one and its duration (how POV cuts look).",
    inputSchema: {
      type: "object",
      properties: {
        transitionName: { type: "string", description: "e.g. 'Fade', 'Cut', 'Luma Wipe'." },
        durationMs: { type: "number" },
      },
      additionalProperties: false,
    },
    handler: async ({ transitionName, durationMs }) => {
      if (transitionName)
        await obs.request("SetCurrentSceneTransition", { transitionName });
      if (durationMs)
        await obs.request("SetCurrentSceneTransitionDuration", { transitionDuration: durationMs });
      return obs.request("GetSceneTransitionList");
    },
  },
  {
    name: "obs_filters",
    description:
      "List filters on a source, or add one. Useful filters: 'noise_suppress_filter_v2' (RNNoise mic " +
      "cleanup), 'noise_gate_filter', 'compressor_filter', 'chroma_key_filter_v2', 'color_filter_v2', " +
      "'async_delay_filter' (sync a lagging network camera to the others).",
    inputSchema: {
      type: "object",
      properties: {
        sourceName: { type: "string" },
        addFilterName: { type: "string" },
        addFilterKind: { type: "string" },
        addFilterSettings: { type: "object" },
      },
      required: ["sourceName"],
      additionalProperties: false,
    },
    handler: async ({ sourceName, addFilterName, addFilterKind, addFilterSettings }) => {
      if (addFilterName && addFilterKind)
        await obs.request("CreateSourceFilter", {
          sourceName,
          filterName: addFilterName,
          filterKind: addFilterKind,
          filterSettings: addFilterSettings || {},
        });
      return obs.request("GetSourceFilterList", { sourceName });
    },
  },
  {
    name: "obs_raw",
    description:
      "ESCAPE HATCH. Call any obs-websocket v5 request directly by name with a raw payload. " +
      "Covers everything the wrapped tools do not, including plugin-provided vendor requests. " +
      "See the obs-websocket protocol reference for request names.",
    inputSchema: {
      type: "object",
      properties: {
        requestType: { type: "string", description: "e.g. 'GetHotkeyList', 'TriggerHotkeyByName'." },
        requestData: { type: "object", description: "Payload for that request." },
      },
      required: ["requestType"],
      additionalProperties: false,
    },
    handler: async ({ requestType, requestData }) => obs.request(requestType, requestData || {}),
  },
];

/*
 * Additive tool modules from mcp/tools/.
 *
 * The 23 tools above are untouched on purpose - they have been driving a live
 * broadcast for eight days. Modules bolt capabilities on beside them; if one
 * fails to load the registry logs it and the working set still starts.
 */
TOOLS.push(...require("./mcp/tools")(obs, log));

const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

/* ------------------------------------------------------------------ *
 * MCP stdio transport (newline-delimited JSON-RPC 2.0)
 * ------------------------------------------------------------------ */
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const ok = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

// Tracks in-flight work so we never exit with requests still pending.
let inFlight = 0;
let stdinClosed = false;
const maybeExit = () => {
  if (stdinClosed && inFlight === 0) process.exit(0);
};

async function handle(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  try {
    if (method === "initialize") {
      const requested = params && params.protocolVersion;
      return ok(id, {
        protocolVersion: requested || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }

    if (method === "notifications/initialized" || method === "notifications/cancelled") return;

    if (method === "ping") return ok(id, {});

    if (method === "tools/list") {
      return ok(id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
    }

    if (method === "tools/call") {
      const tool = TOOL_MAP.get(params && params.name);
      if (!tool) return fail(id, -32602, `Unknown tool: ${params && params.name}`);
      try {
        const result = await tool.handler(params.arguments || {});
        if (tool.raw) return ok(id, result);
        return ok(id, {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        });
      } catch (e) {
        return ok(id, {
          content: [{ type: "text", text: `ERROR: ${e.message}` }],
          isError: true,
        });
      }
    }

    if (isNotification) return;
    return fail(id, -32601, `Method not found: ${method}`);
  } catch (e) {
    if (!isNotification) fail(id, -32603, e.message);
  }
}

let buf = "";
let queue = Promise.resolve();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    // Serialize: guarantees "create X" fully completes before "modify X" runs,
    // regardless of how the client batches requests.
    inFlight++;
    queue = queue
      .then(() => handle(msg))
      .catch(() => {})
      .finally(() => {
        inFlight--;
        maybeExit();
      });
  }
});
process.stdin.on("end", () => {
  stdinClosed = true;
  // Give any in-flight OBS round trips a chance to finish instead of
  // dropping them the instant the pipe closes.
  maybeExit();
  setTimeout(() => process.exit(0), 20000).unref();
});

log(`ready. target ${OBS_URL}, auth ${OBS_PASSWORD ? "enabled" : "NONE SET"}`);
