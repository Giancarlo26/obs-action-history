"use strict";
/*
 * Outputs: everything OBS can be sending somewhere, including the things no
 * dedicated tool covers.
 *
 * obs_stream_control and obs_record_control already handle the two outputs
 * OBS considers special. They handle nothing else, and on the reference machine "everything
 * else" is most of them. GetOutputList on the live machine returned five:
 *
 *   adv_stream          rtmp_output        ACTIVE   <- the broadcast
 *   adv_file_output     mp4_output                  <- the local recording
 *   Replay Buffer       replay_buffer
 *   virtualcam_output   virtualcam_output
 *   Vertical Backtrack  replay_buffer               <- from the vertical-canvas plugin
 *
 * That last one is the point. A plugin that adds a second canvas brings its own
 * outputs, named however the plugin's author felt like naming them - there is no
 * convention, no prefix, and OBS's own stream/record requests cannot see them.
 * Writing a bespoke tool per plugin does not scale and goes stale the moment
 * somebody installs another one. Enumerating outputs does not.
 *
 * So: always list before you act. The names in the comment above are what this
 * machine had on one day, not a contract - a different profile or a plugin
 * update changes the set.
 *
 * The mutating handlers here were written against the obs-websocket v5 protocol
 * reference and deliberately never executed: the rig was mid-broadcast, and the
 * whole failure mode this module warns about is stopping the wrong one.
 */

// OBS reports these as an object of booleans on each output in GetOutputList.
const isService = (o) => !!(o && o.outputFlags && o.outputFlags.OBS_OUTPUT_SERVICE);

function describe(o) {
  if (isService(o)) return "THE BROADCAST - goes to a streaming service. Stopping it ends the stream for every viewer.";
  switch (o.outputKind) {
    case "replay_buffer": return "Replay buffer - holds the last N seconds in memory and writes a clip only when saved.";
    case "virtualcam_output": return "Virtual camera - makes OBS appear as a webcam to other apps. Nothing to do with the broadcast.";
    case "mp4_output":
    case "ffmpeg_muxer": return "Local recording to disk.";
    default: return "Non-service output. Check its kind and settings before assuming what it does.";
  }
}

module.exports = (obs) => [
  {
    name: "obs_list_outputs",
    description:
      "List every output OBS currently has - the stream, the recording, the replay buffer, the virtual " +
      "camera, and any output contributed by a plugin - with which ones are running right now.\n" +
      "\n" +
      "Start here before touching anything in this module, because the names are not predictable. " +
      "OBS's own are internal ids (adv_stream, adv_file_output); plugin outputs use whatever label the " +
      "plugin chose, and on the reference machine the vertical-canvas plugin contributes one called 'Vertical " +
      "Backtrack' that also reports its width and height as 0 in this list, which is the plugin not " +
      "filling those in rather than a broken output. Do not infer what an output does from its name.\n" +
      "\n" +
      "The field that actually matters is outputFlags.OBS_OUTPUT_SERVICE. True means the output feeds a " +
      "streaming service - that is the live broadcast, and on the reference machine exactly one output has it: " +
      "adv_stream, which is the single RTMP connection to the local relay that fans out to Twitch, " +
      "YouTube and Kick. Everything downstream of it dies together, so 'which platform does this stop' " +
      "has no useful answer: it stops all three. This tool annotates each output with that reading so " +
      "the distinction is not left to name-guessing.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => {
      const r = await obs.request("GetOutputList");
      const outputs = (r.outputs || []).map((o) => ({
        outputName: o.outputName,
        outputKind: o.outputKind,
        outputActive: o.outputActive,
        isBroadcast: isService(o),
        width: o.outputWidth,
        height: o.outputHeight,
        outputFlags: o.outputFlags,
        what: describe(o),
      }));
      return {
        count: outputs.length,
        active: outputs.filter((o) => o.outputActive).map((o) => o.outputName),
        broadcast: outputs.filter((o) => o.isBroadcast).map((o) => o.outputName),
        outputs,
      };
    },
  },

  {
    name: "obs_output_status",
    description:
      "Live health of an output: whether it is running, how long it has been running, how many bytes it " +
      "has pushed, how many frames it dropped, and how congested it is. Omit outputName to get all of " +
      "them at once, which is the fastest read of 'what is this machine actually doing right now'.\n" +
      "\n" +
      "Read outputActive first and let it gate everything else, because the counters are NOT cleared " +
      "when an output stops. On the live rig, adv_file_output reported outputActive false alongside " +
      "1.68 GB of outputBytes and 131,933 outputTotalFrames - leftovers from the previous recording " +
      "session. Reading bytes alone would say the recording is running when it has not been for hours. " +
      "outputTimecode and outputDuration are the ones that do reset to zero, so they agree with " +
      "outputActive.\n" +
      "\n" +
      "For a stream that is up, the two numbers to watch over time are outputSkippedFrames and " +
      "outputCongestion. Congestion is a percentage of how close the encoder is to not keeping up; " +
      "rising congestion with climbing skipped frames means the upload or the encoder is the bottleneck " +
      "and viewers are seeing it. outputReconnecting true means the connection dropped and OBS is trying " +
      "to re-establish it - the broadcast is interrupted even though outputActive has not gone false.\n" +
      "\n" +
      "One caution specific to this setup: healthy numbers here only prove OBS is successfully pushing " +
      "bytes into the local relay. They say nothing about whether the relay is still forwarding to each " +
      "platform. A YouTube broadcast can be receiving nothing while this reports a perfect stream.",
    inputSchema: {
      type: "object",
      properties: {
        outputName: {
          type: "string",
          description: "Exact output name from obs_list_outputs. Omit for every output.",
        },
      },
      additionalProperties: false,
    },
    handler: async ({ outputName }) => {
      if (outputName) {
        const s = await obs.request("GetOutputStatus", { outputName });
        return { outputName, ...s };
      }
      const list = await obs.request("GetOutputList");
      const out = [];
      for (const o of list.outputs || []) {
        try {
          const s = await obs.request("GetOutputStatus", { outputName: o.outputName });
          out.push({ outputName: o.outputName, outputKind: o.outputKind, isBroadcast: isService(o), ...s });
        } catch (e) {
          out.push({ outputName: o.outputName, error: String((e && e.message) || e) });
        }
      }
      return {
        note: "Counters persist after an output stops. Trust outputActive, not outputBytes.",
        outputs: out,
      };
    },
  },

  {
    name: "obs_get_output_settings",
    description:
      "Read one output's settings object. Use it before obs_set_output_settings, because the keys an " +
      "output accepts depend entirely on its kind and there is no schema request for them - the object " +
      "you get back IS the list of keys that mean anything.\n" +
      "\n" +
      "Expect less than you think. adv_stream on the reference machine returns only bind_ip, ip_family, dyn_bitrate, " +
      "low_latency_mode_enabled and new_socket_loop_enabled: network tuning, and nothing else. There is " +
      "no server URL and no stream key in there. The destination lives on the stream SERVICE, which is " +
      "part of the profile, not the output - so reading this to find out where the rig is streaming will " +
      "not tell you, and neither will writing to it change where the rig streams. Bitrate and encoder " +
      "settings are likewise profile-level, not here.",
    inputSchema: {
      type: "object",
      properties: {
        outputName: { type: "string", description: "Exact output name from obs_list_outputs." },
      },
      required: ["outputName"],
      additionalProperties: false,
    },
    handler: async ({ outputName }) => {
      const r = await obs.request("GetOutputSettings", { outputName });
      const settings = r.outputSettings || {};
      return {
        outputName,
        outputSettings: settings,
        keys: Object.keys(settings),
        note: "These are the only keys this output understands. Stream destination, key, bitrate and encoder are NOT here - they belong to the profile's stream service.",
      };
    },
  },

  {
    name: "obs_set_output_settings",
    description:
      "Write an output's settings. This REPLACES the settings object rather than merging into it, so " +
      "read obs_get_output_settings first and send the full object with your change applied - sending " +
      "one key on its own is how you lose the others.\n" +
      "\n" +
      "Do not reach for this to change where the stream goes or how good it looks. The destination and " +
      "stream key belong to the profile's stream service, and bitrate and encoder belong to the profile; " +
      "none of them appear in an output's settings. What is here is network-level behaviour - which " +
      "interface to bind, IPv4 vs IPv6, dynamic bitrate, low-latency mode. For anything about quality or " +
      "destination, use obs_profile_and_collection.\n" +
      "\n" +
      "Change settings while the output is stopped. A running output has already read its configuration, " +
      "and a write that appears to succeed may do nothing until the next start - which reads as a broken " +
      "tool when it is really a timing mistake. On a live broadcast, changing adv_stream's networking " +
      "settings is not a safe experiment: verify with obs_output_status afterwards and be ready for the " +
      "possibility that it takes the connection down.",
    inputSchema: {
      type: "object",
      properties: {
        outputName: { type: "string", description: "Exact output name from obs_list_outputs." },
        outputSettings: {
          type: "object",
          description: "The COMPLETE settings object. Start from obs_get_output_settings and modify it; omitted keys are not preserved.",
        },
      },
      required: ["outputName", "outputSettings"],
      additionalProperties: false,
    },
    handler: async ({ outputName, outputSettings }) => {
      await obs.request("SetOutputSettings", { outputName, outputSettings });
      // Read back rather than trusting the ack.
      const after = await obs.request("GetOutputSettings", { outputName }).catch(() => ({}));
      return {
        ok: true,
        outputName,
        requested: outputSettings,
        nowReads: after.outputSettings,
        note: "Read back from OBS. If a value did not change, the key is not one this output kind understands, or it only applies on the next start.",
      };
    },
  },

  {
    name: "obs_output_control",
    description:
      "Start, stop or toggle any output by name - covers StartOutput, StopOutput and ToggleOutput. This " +
      "is the general lever for outputs that have no dedicated tool: the replay buffer, the virtual " +
      "camera, and above all the outputs a plugin brought with it, such as the vertical canvas's own " +
      "recording on the reference machine. Without it, a whole second canvas is unreachable.\n" +
      "\n" +
      "Know which output you are aiming at before you fire. Stopping the SERVICE output ends the " +
      "broadcast for every viewer on every platform simultaneously - here that is adv_stream, the one " +
      "RTMP connection into the local relay that feeds Twitch, YouTube and Kick, so there is no such " +
      "thing as stopping just one platform from OBS. Stopping the local recording (adv_file_output) is " +
      "merely annoying by comparison. Stopping a replay buffer discards what is in memory. Because these " +
      "are so far apart in consequence and the names give no hint, this tool refuses to stop a service " +
      "output unless you pass confirm:true, and names the output in the refusal.\n" +
      "\n" +
      "For the main stream and the main recording, prefer obs_stream_control and obs_record_control. " +
      "Those are the paths the rest of the reference machine's tooling and OBS's own state follow; this tool operates " +
      "on the raw output and is the right choice only for what they do not cover.\n" +
      "\n" +
      "'toggle' is convenient and dangerous in the same way: it decides based on state you have not " +
      "looked at, so a toggle aimed at something you believed was stopped will stop it instead. Check " +
      "obs_output_status first, or use explicit start/stop. Starting an already-running output, or " +
      "stopping an already-stopped one, is an error rather than a no-op - this tool reports the state it " +
      "found instead of failing obscurely.",
    inputSchema: {
      type: "object",
      properties: {
        outputName: { type: "string", description: "Exact output name from obs_list_outputs." },
        action: {
          type: "string",
          enum: ["start", "stop", "toggle"],
          description: "'toggle' flips whatever the current state is - prefer explicit start/stop.",
        },
        confirm: {
          type: "boolean",
          description: "Required (true) only to stop or toggle-off an output that feeds a streaming service, i.e. to end the live broadcast on every platform at once.",
        },
      },
      required: ["outputName", "action"],
      additionalProperties: false,
    },
    handler: async ({ outputName, action, confirm }) => {
      const list = await obs.request("GetOutputList");
      const target = (list.outputs || []).find((o) => o.outputName === outputName);
      if (!target) {
        const names = (list.outputs || []).map((o) => o.outputName);
        throw new Error(
          `No output named "${outputName}". OBS has: ${names.join(", ")}. ` +
          `Use obs_list_outputs - output names are internal ids or plugin-chosen labels, not guessable.`
        );
      }

      const wasActive = !!target.outputActive;
      const willStop = action === "stop" || (action === "toggle" && wasActive);

      if (willStop && isService(target) && confirm !== true) {
        throw new Error(
          `"${outputName}" is the streaming service output - stopping it ends the live broadcast on ` +
          `every platform at once (here: Twitch, YouTube and Kick, which all hang off this one ` +
          `connection). Re-send with confirm:true if that is genuinely what you want. To stop ` +
          `recording or a plugin output instead, pick that output by name from obs_list_outputs.`
        );
      }

      // Report the no-op rather than letting OBS reject it with a terse code.
      if (action === "start" && wasActive) {
        return { ok: true, outputName, action, changed: false, outputActive: true, note: "Already running; nothing done." };
      }
      if (action === "stop" && !wasActive) {
        return { ok: true, outputName, action, changed: false, outputActive: false, note: "Already stopped; nothing done." };
      }

      if (action === "start") await obs.request("StartOutput", { outputName });
      else if (action === "stop") await obs.request("StopOutput", { outputName });
      else await obs.request("ToggleOutput", { outputName });

      const status = await obs.request("GetOutputStatus", { outputName }).catch(() => ({}));
      return {
        ok: true,
        outputName,
        action,
        isBroadcast: isService(target),
        wasActive,
        outputActive: status.outputActive,
        changed: status.outputActive !== wasActive,
        status,
        note: "State read back from OBS. Starting an output can take a moment; if outputActive is still false, re-check with obs_output_status before retrying.",
      };
    },
  },
];
