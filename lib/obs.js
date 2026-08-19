"use strict";
/*
 * The obs-websocket client, in ONE place.
 *
 * The handshake used to be copy-pasted into seventeen files, and the copies
 * were not equivalent. Measured, before this file existed:
 *
 *   - per-request timeout          1 of 17. The rest waited forever.
 *   - handled the socket closing   4 of 17.
 *   - rejected in-flight requests
 *     when the socket died         1 of 17.
 *   - said "wrong password" when
 *     OBS closed with code 4009    1 of 17. The rest said "could not connect",
 *                                  which sends you to debug the wrong thing.
 *   - could REMOVE an event
 *     listener                     1 of 17.
 *   - used RequestBatch            0 of 17.
 *
 * Every one of those gaps has cost something real. The missing close handler
 * left music/player.js alive with a dead socket for seventeen hours: the next
 * track only ever fires on MediaInputPlaybackEnded, which could no longer
 * arrive, so the music stopped while the supervisor and the panel both showed
 * a green chip. The missing unsubscribe made director.js's calibration collect
 * both speakers into one sample, so the two medians came out identical.
 *
 * Usage:
 *
 *   const obs = require("../lib/obs");
 *   const c = await obs.connect({ events: ["scenes", "meters"] });
 *   await c.req("SetCurrentProgramScene", { sceneName: "10 BRB" });
 *   const [a, b] = await c.batch([["GetSceneList"], ["GetInputList"]]);
 *   const off = c.on("InputVolumeMeters", (d) => ...);   // off() to stop
 *   c.close();
 */
const crypto = require("crypto");
const obsPassword = require("./obs-secret");

const DEFAULT_URL = process.env.OBS_WEBSOCKET_URL || "ws://127.0.0.1:4455";

/*
 * Event subscription bits, by name.
 *
 * These are a BITMASK, not a list, and the high ones are opt-in for a reason:
 * "meters" alone is roughly 50 messages a second per audio source. Ask for
 * what you need. `eventSubscriptions: 0` - the old default everywhere - means
 * the socket can act on OBS but can never react to it.
 */
const SUB = {
  general: 1 << 0,
  config: 1 << 1,
  scenes: 1 << 2,
  inputs: 1 << 3,
  transitions: 1 << 4,
  filters: 1 << 5,
  outputs: 1 << 6,
  sceneItems: 1 << 7,
  media: 1 << 8,
  vendors: 1 << 9,
  ui: 1 << 10,
  // High-volume, deliberately outside "all".
  meters: 1 << 16,
  inputActive: 1 << 17,
  inputShow: 1 << 18,
  itemTransform: 1 << 19,
};
const SUB_ALL = (1 << 11) - 1;

function maskFor(events) {
  if (events === undefined || events === null) return 0;
  if (typeof events === "number") return events;
  let m = 0;
  for (const name of [].concat(events)) {
    if (name === "all") { m |= SUB_ALL; continue; }
    if (!(name in SUB)) throw new Error(`unknown OBS event group "${name}" (have: ${Object.keys(SUB).join(", ")})`);
    m |= SUB[name];
  }
  return m;
}

// OBS closes with 4009 when the password is wrong. Saying so is the single
// most useful thing this file does on a machine being set up for the first
// time, where the usual message is a timeout that reads as "OBS is not
// running" - and OBS is running fine.
function closeReason(code) {
  if (code === 4009) return "OBS rejected the password - check secrets.json (OBS > Tools > WebSocket Server Settings)";
  if (code === 4008) return "OBS expected authentication and got none - check secrets.json";
  if (code === 4002) return "OBS rejected the protocol version (obs-websocket too old?)";
  return null;
}

function connect(opts = {}) {
  const url = opts.url || DEFAULT_URL;
  const password = opts.password !== undefined ? opts.password : obsPassword();
  const mask = maskFor(opts.events);
  const timeout = opts.timeout || 15000;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    const listeners = new Map();      // eventType -> Set(fn)
    const closeFns = [];
    let seq = 0;
    let settled = false;
    let closingOnPurpose = false;
    let lastCloseCode = null;

    const openTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      reject(new Error(`timed out connecting to OBS at ${url}`));
    }, timeout);

    const fail = (msg) => {
      if (settled) return;
      settled = true;
      clearTimeout(openTimer);
      reject(new Error(msg));
    };

    ws.addEventListener("error", () => fail(`could not connect to OBS at ${url}`));

    ws.addEventListener("close", (ev) => {
      lastCloseCode = ev && ev.code;
      const why = closeReason(lastCloseCode);
      if (!settled) return fail(why || `could not connect to OBS at ${url}`);
      // Everything still in flight must reject. Leaving these promises
      // pending is what made a dead socket look like a slow one.
      const err = new Error(why || `OBS closed the connection (code ${lastCloseCode})`);
      for (const [, p] of pending) p.rej(err);
      pending.clear();
      if (!closingOnPurpose) for (const fn of closeFns) { try { fn(err); } catch {} }
    });

    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());

      if (m.op === 0) {
        const d = m.d;
        const id = { rpcVersion: d.rpcVersion || 1, eventSubscriptions: mask };
        if (d.authentication) {
          const s = crypto.createHash("sha256").update(password + d.authentication.salt).digest("base64");
          id.authentication = crypto.createHash("sha256").update(s + d.authentication.challenge).digest("base64");
        }
        ws.send(JSON.stringify({ op: 1, d: id }));
        return;
      }

      if (m.op === 2) {                       // identified
        settled = true;
        clearTimeout(openTimer);
        resolve(client);
        return;
      }

      if (m.op === 5) {                       // event
        const set = listeners.get(m.d.eventType);
        if (set) for (const fn of set) { try { fn(m.d.eventData || {}, m.d.eventType); } catch {} }
        const any = listeners.get("*");
        if (any) for (const fn of any) { try { fn(m.d.eventData || {}, m.d.eventType); } catch {} }
        return;
      }

      if (m.op === 7) {                       // request response
        const p = pending.get(m.d.requestId);
        if (!p) return;
        clearTimeout(p.timer);
        pending.delete(m.d.requestId);
        m.d.requestStatus.result
          ? p.res(m.d.responseData || {})
          : p.rej(new Error(m.d.requestStatus.comment || m.d.requestStatus.code));
        return;
      }

      if (m.op === 9) {                       // batch response
        const p = pending.get(m.d.requestId);
        if (!p) return;
        clearTimeout(p.timer);
        pending.delete(m.d.requestId);
        p.res((m.d.results || []).map((r) =>
          r.requestStatus && r.requestStatus.result
            ? (r.responseData || {})
            : { error: (r.requestStatus && (r.requestStatus.comment || r.requestStatus.code)) || "failed" }));
      }
    });

    // Every request gets a deadline. Without one, a wedged OBS turns into a
    // promise that never settles, and the caller hangs for good - which is
    // how the panel's health check froze exactly when OBS broke.
    const send = (op, d, requestId) => new Promise((res, rej) => {
      if (ws.readyState !== 1) return rej(new Error("not connected to OBS"));
      const timer = setTimeout(() => {
        pending.delete(requestId);
        rej(new Error(`OBS did not answer ${d.requestType || "batch"} within ${timeout} ms`));
      }, timeout);
      pending.set(requestId, { res, rej, timer });
      ws.send(JSON.stringify({ op, d }));
    });

    const client = {
      req: (requestType, requestData) => {
        const requestId = `r${++seq}`;
        return send(6, { requestType, requestId, requestData: requestData || {} }, requestId);
      },

      // One round trip instead of N. Nothing used this before.
      batch: (calls, { halt = false } = {}) => {
        const requestId = `b${++seq}`;
        return send(8, {
          requestId,
          haltOnFailure: halt,
          requests: calls.map(([requestType, requestData]) => ({ requestType, requestData: requestData || {} })),
        }, requestId);
      },

      // Returns an unsubscribe. Callers that collect samples in phases MUST
      // use it: a listener left alive through a second phase mixes the two.
      on: (eventType, fn) => {
        if (!listeners.has(eventType)) listeners.set(eventType, new Set());
        listeners.get(eventType).add(fn);
        return () => {
          const set = listeners.get(eventType);
          if (set) set.delete(fn);
        };
      },

      onClose: (fn) => { closeFns.push(fn); return () => { const i = closeFns.indexOf(fn); if (i >= 0) closeFns.splice(i, 1); }; },

      close: () => { closingOnPurpose = true; try { ws.close(); } catch {} },
      get connected() { return ws.readyState === 1; },
      get closeCode() { return lastCloseCode; },
    };
  });
}

/*
 * connect(), but it keeps trying and keeps re-applying.
 *
 * For the long-running services. `onReady` fires on every successful connect,
 * including reconnects, which is where a service re-registers its listeners -
 * OBS restarting must not silently leave a process running against a socket
 * that will never deliver another event.
 */
async function connectForever(opts = {}) {
  const onReady = opts.onReady || (() => {});
  const log = opts.log || (() => {});
  let delay = 1000;
  const maxDelay = opts.maxDelay || 30000;

  for (;;) {
    try {
      const c = await connect(opts);
      delay = 1000;
      let done = false;
      c.onClose((err) => { if (!done) { done = true; log(`OBS connection lost: ${err.message}`); } });
      await onReady(c);
      return c;
    } catch (e) {
      const fatal = c_isAuth(e);
      log(`${e.message}${fatal ? "" : ` - retrying in ${Math.round(delay / 1000)}s`}`);
      if (fatal) throw e;                    // a wrong password will not fix itself
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(maxDelay, Math.round(delay * 1.6));
    }
  }
}

const c_isAuth = (e) => /rejected the password|expected authentication/.test(e.message);

module.exports = { connect, connectForever, SUB, maskFor, closeReason };
