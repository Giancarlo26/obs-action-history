"use strict";
/*
 * Audio ROUTING - where a sound goes, as opposed to how loud it is.
 *
 * The server already had obs_audio_control for mute and volume. That answers
 * "how loud", and nothing answered "where does this actually come out". Those
 * are different questions and the second one is where a stream breaks in ways
 * nobody can hear from the operator's chair:
 *
 *   - a source on no audio track at all is inaudible AND does not meter, so
 *     every level-based tool reports it as silence and you go looking for a
 *     dead microphone that is working fine;
 *   - a source monitored to the speakers is picked up by the microphone in
 *     the room and goes out twice, slightly apart, which sounds like a bad
 *     encoder rather than like a routing mistake;
 *   - a sync offset above the cap applies as nothing while the request
 *     returns success.
 *
 * None of those are visible in a level meter, so all three tools here read
 * back what OBS actually holds after a write, and obs_audio_routing_map exists
 * to answer the whole question in one call instead of twenty-four.
 */

const MONITOR_TYPES = [
  "OBS_MONITORING_TYPE_NONE",
  "OBS_MONITORING_TYPE_MONITOR_ONLY",
  "OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT",
];

// OBS has six audio tracks, fixed.
const TRACKS = ["1", "2", "3", "4", "5", "6"];

const trackProps = () => {
  const p = {};
  for (const t of TRACKS) p[t] = { type: "boolean" };
  return p;
};

// Beyond this, OBS accepts the request and applies nothing. Measured on this
// rig; the protocol itself advertises 20000, which is the whole problem.
const SYNC_SILENT_CAP_MS = 960;

const readAll = async (obs, inputName) => {
  const miss = () => ({});
  const [mon, sync, tracks, bal] = await Promise.all([
    obs.request("GetInputAudioMonitorType", { inputName }).catch(miss),
    obs.request("GetInputAudioSyncOffset", { inputName }).catch(miss),
    obs.request("GetInputAudioTracks", { inputName }).catch(miss),
    obs.request("GetInputAudioBalance", { inputName }).catch(miss),
  ]);
  return {
    inputName,
    monitorType: mon.monitorType,
    syncOffsetMs: sync.inputAudioSyncOffset,
    tracks: tracks.inputAudioTracks,
    balance: bal.inputAudioBalance,
  };
};

const enabledTracks = (tracks) =>
  tracks ? TRACKS.filter((t) => tracks[t]) : [];

/* Every way one input can be quietly wrong. Shared by the single-input tool
 * and the map so they can never disagree about what counts as a problem. */
const auditOne = (row) => {
  const notes = [];
  const on = enabledTracks(row.tracks);

  if (row.tracks && on.length === 0)
    notes.push(
      "on NO audio track: inaudible everywhere and it will not meter either, " +
        "so level-based tools will report it as a dead source rather than a routing mistake"
    );
  else if (row.tracks && !row.tracks["1"])
    notes.push(
      `off track 1, on ${on.join("+")}: it meters, but on the reference machine only track 1 is ` +
        "streamed and recorded, so nobody outside OBS hears it. Deliberate for a " +
        "detection microphone, a bug for anything else"
    );

  if (row.monitorType && row.monitorType !== "OBS_MONITORING_TYPE_NONE")
    notes.push(
      `monitoring is ${row.monitorType}: this is playing out of the room speakers, ` +
        "where an open microphone picks it up again and it leaves twice, out of phase"
    );

  if (typeof row.syncOffsetMs === "number" && Math.abs(row.syncOffsetMs) > SYNC_SILENT_CAP_MS)
    notes.push(
      `sync offset ${row.syncOffsetMs} ms is past the ~${SYNC_SILENT_CAP_MS} ms cap, ` +
        "so it is stored but not applied"
    );

  if (typeof row.balance === "number" && Math.abs(row.balance - 0.5) > 0.001)
    notes.push(
      `balance ${row.balance} is off centre: anyone listening on one earbud ` +
        "hears this quieter, or at 0.0/1.0 not at all"
    );

  return notes;
};

module.exports = (obs) => [
  {
    name: "obs_audio_routing",
    description:
      "Read - and optionally change - WHERE one audio input goes: which recording/stream tracks " +
      "carry it, whether OBS monitors it out of the speakers, its A/V sync offset, and its stereo " +
      "balance. Call it with only inputName to read; every other field is a change. " +
      "This is separate from mute and volume on purpose: those are 'how loud', these are 'does it " +
      "reach anyone at all', and a source can be at 0 dB, unmuted, and still inaudible to viewers. " +
      "TRAPS, all of which return success while doing nothing you wanted: " +
      "(1) syncOffsetMs is capped near 960 ms - OBS accepts far larger values, stores them, and " +
      "applies nothing, so 2000 ms is silently 0. The protocol declares a floor of -950 on the " +
      "negative side but a ceiling of 20000 on the positive one, so only the positive side gets to " +
      "fail quietly. If a feed is more than a second late, cut the real latency; you cannot " +
      "compensate past the cap. " +
      "(2) A source on no track at all does not even meter, so it looks like dead hardware. " +
      "(3) Only the tracks named by RecTracks reach the recording, and only one reaches the stream; " +
      "a source on any other track meters perfectly and reaches nobody. That is how a detection " +
      "microphone exists without being heard, so do not 'fix' such a source onto track 1. " +
      "(4) monitorType anything but NONE sends this to the room speakers, where the microphone picks " +
      "it up and it goes out a second time, out of phase. MONITOR_AND_OUTPUT is the one that does both. " +
      "The reply always contains what OBS holds AFTER the write, plus a `notes` list naming any of the " +
      "above that is now true - trust that over the value you sent.",
    inputSchema: {
      type: "object",
      properties: {
        inputName: { type: "string", description: "Audio input name, exactly as OBS lists it." },
        monitorType: {
          type: "string",
          enum: MONITOR_TYPES,
          description:
            "Omit to leave unchanged. NONE = viewers only (the safe default while live).",
        },
        syncOffsetMs: {
          type: "number",
          description:
            "Omit to leave unchanged. Positive delays this audio to catch up with late video. " +
            "Useful range is about -950..960; larger is accepted and ignored.",
        },
        tracks: {
          type: "object",
          properties: trackProps(),
          additionalProperties: false,
          description:
            "Omit to leave unchanged. Partial is fine - only the tracks you name change, e.g. {\"6\": true}.",
        },
        balance: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description:
            "Omit to leave unchanged. 0.0 hard left, 0.5 centre, 1.0 hard right.",
        },
      },
      required: ["inputName"],
      additionalProperties: false,
    },
    handler: async ({ inputName, monitorType, syncOffsetMs, tracks, balance }) => {
      const changed = [];

      if (monitorType !== undefined) {
        await obs.request("SetInputAudioMonitorType", { inputName, monitorType });
        changed.push("monitorType");
      }
      if (syncOffsetMs !== undefined) {
        await obs.request("SetInputAudioSyncOffset", {
          inputName,
          inputAudioSyncOffset: syncOffsetMs,
        });
        changed.push("syncOffsetMs");
      }
      if (tracks !== undefined) {
        await obs.request("SetInputAudioTracks", { inputName, inputAudioTracks: tracks });
        changed.push("tracks");
      }
      if (balance !== undefined) {
        await obs.request("SetInputAudioBalance", { inputName, inputAudioBalance: balance });
        changed.push("balance");
      }

      // Read-back is the point. A silently-ignored write is the failure mode
      // this whole module exists for, so never report the requested value.
      const now = await readAll(obs, inputName);
      const notes = auditOne(now);

      if (syncOffsetMs !== undefined && now.syncOffsetMs !== syncOffsetMs)
        notes.unshift(
          `asked for ${syncOffsetMs} ms of sync offset and OBS is holding ${now.syncOffsetMs} ms`
        );

      return {
        ...now,
        tracksEnabled: enabledTracks(now.tracks),
        changed: changed.length ? changed : "nothing - read only",
        notes,
      };
    },
  },

  {
    name: "obs_audio_routing_map",
    description:
      "The whole audio routing picture in one call: every input that carries audio, with its tracks, " +
      "monitoring, sync offset and balance, and an explicit list of what is misrouted. " +
      "Read-only. Start here when audio is wrong and you do not yet know which source is at fault - " +
      "the alternative is four requests per input, and the answer is usually a comparison between " +
      "sources rather than a fact about one of them. " +
      "It names the failures that a level meter cannot show you: sources on no track (inaudible AND " +
      "unmeterable), sources off track 1 (they meter but never reach the stream or the recording on " +
      "the reference machine), monitoring left enabled (doubled, out-of-phase audio via the room microphone), sync " +
      "offsets stored past the ~960 ms cap where OBS applies nothing, and balances pushed off centre. " +
      "Inputs with no audio at all are skipped rather than listed as errors.",
    inputSchema: {
      type: "object",
      properties: {
        onlyProblems: {
          type: "boolean",
          description: "true = return only inputs with at least one note. Default false.",
        },
      },
      additionalProperties: false,
    },
    handler: async ({ onlyProblems }) => {
      const list = await obs.request("GetInputList");
      const names = (list.inputs || []).map((i) => i.inputName);

      const rows = [];
      for (const inputName of names) {
        const row = await readAll(obs, inputName);
        // No monitor type and no track object means this input has no audio
        // channel at all - a browser overlay, a colour source. Not a fault.
        if (row.monitorType === undefined && row.tracks === undefined) continue;
        rows.push({
          inputName,
          tracks: enabledTracks(row.tracks).join("+") || "NONE",
          monitorType: row.monitorType,
          syncOffsetMs: row.syncOffsetMs,
          balance: row.balance,
          notes: auditOne(row),
        });
      }

      const problems = rows.filter((r) => r.notes.length);
      return {
        inputs: onlyProblems ? problems : rows,
        audioInputs: rows.length,
        withNotes: problems.length,
        summary: problems.length
          ? `${problems.length} of ${rows.length} audio inputs have a routing note`
          : `all ${rows.length} audio inputs route cleanly`,
      };
    },
  },

  {
    name: "obs_special_inputs",
    description:
      "Names of OBS's six built-in audio slots: Desktop Audio, Desktop Audio 2, and Mic/Aux 1-4. " +
      "Read-only. " +
      "The trap is what an empty answer means. Any slot a user never configured comes back null, and " +
      "on a rig that creates its audio sources explicitly - which is every rig built by a script - all " +
      "six are null. On this machine they are: every audio source here, microphones included, is a " +
      "named input, not a special slot. Six nulls therefore means 'this OBS has no special inputs " +
      "assigned, go read the input list', NOT 'this OBS has no audio' and NOT 'the request failed'. " +
      "Use this to resolve the two names OBS itself uses in its settings UI; use obs_audio_routing_map " +
      "to actually find the microphones.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => {
      const r = await obs.request("GetSpecialInputs");
      const slots = ["desktop1", "desktop2", "mic1", "mic2", "mic3", "mic4"];
      const assigned = slots.filter((s) => r[s]);
      return {
        ...r,
        assigned: assigned.length ? assigned.map((s) => `${s}=${r[s]}`) : [],
        note: assigned.length
          ? undefined
          : "No special input slots are assigned. This is normal for a scripted rig - " +
            "every audio source is a named input instead. Use obs_audio_routing_map or " +
            "obs_list_inputs to find the microphones.",
      };
    },
  },
];
