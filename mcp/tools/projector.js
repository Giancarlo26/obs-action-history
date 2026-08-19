"use strict";
/*
 * Projectors - putting an OBS output onto a physical screen.
 *
 * WHAT A PROJECTOR IS FOR
 *
 * A projector is a bare window, or a whole monitor, showing one video feed with
 * no OBS chrome around it. That makes it the normal way to hand a picture to
 * hardware or to another machine WITHOUT re-encoding it: point a capture card
 * at a fullscreen projector on a second monitor and the card sees clean program
 * output at full rate. It is also how you put a confidence monitor in front of
 * the people on camera, and how you show one source - a guest's feed, a screen
 * share - on its own display.
 *
 * THE ONE-WAY DOOR
 *
 * obs-websocket v5 has no request that closes a projector, and none that lists
 * the ones already open. Verified against the 5.7.4 protocol reference: the Ui
 * category contains GetMonitorList, OpenVideoMixProjector and
 * OpenSourceProjector, and nothing else touching projectors. So opening one
 * over the websocket is irreversible over the websocket - a person has to close
 * the window in the OBS UI. Open them deliberately, and not while nobody is
 * sitting at the machine.
 *
 * THE REFERENCE MACHINE HAD EXACTLY ONE MONITOR
 *
 * GetMonitorList returns a single 1920x1080 display at index 0, which is the
 * screen OBS itself is on and the screen the operator is looking at. A
 * fullscreen projector on index 0 covers the OBS window mid-broadcast and
 * cannot be dismissed from here. Windowed mode - monitorIndex omitted, or -1 -
 * is the safe default and the one these tools use when you say nothing.
 */

const MIX_TYPES = {
  preview: "OBS_WEBSOCKET_VIDEO_MIX_TYPE_PREVIEW",
  program: "OBS_WEBSOCKET_VIDEO_MIX_TYPE_PROGRAM",
  multiview: "OBS_WEBSOCKET_VIDEO_MIX_TYPE_MULTIVIEW",
};

// monitorIndex and projectorGeometry are mutually exclusive per the protocol.
// Sending both is a request whose behaviour is undefined, so refuse locally
// rather than find out live.
function placement({ monitorIndex, projectorGeometry }) {
  if (monitorIndex !== undefined && projectorGeometry !== undefined) {
    throw new Error("monitorIndex and projectorGeometry are mutually exclusive - give one or neither");
  }
  const d = {};
  if (monitorIndex !== undefined) d.monitorIndex = monitorIndex;
  if (projectorGeometry !== undefined) d.projectorGeometry = projectorGeometry;
  return d;
}

const closeNote =
  "obs-websocket cannot close or enumerate projectors - this window stays until someone closes it in the OBS UI.";

const fullscreenWarning = (monitorIndex) =>
  monitorIndex !== undefined && monitorIndex >= 0
    ? `fullscreen on monitor ${monitorIndex}; if that is the operator's only display it now covers OBS, and ${closeNote}`
    : undefined;

module.exports = (obs) => [
  {
    name: "obs_monitor_list",
    description:
      "List the physical displays OBS can put a fullscreen projector on, with the index each one answers to. " +
      "Always call this before opening a fullscreen projector: the index is positional, it is not stable " +
      "across replugging a display, and there is no request that tells you which one OBS's own window is on.\n\n" +
      "If this returns a single monitor - which is what the reference machine reports, one 1920x1080 at index 0 - then " +
      "there is no spare screen, and every fullscreen projector will land on top of the operator's OBS " +
      "window. Since obs-websocket has no way to close a projector, that has to be undone by hand at the " +
      "machine. Use windowed mode instead when the count is 1.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => {
      const { monitors = [] } = await obs.request("GetMonitorList", {});
      return {
        count: monitors.length,
        monitors,
        note: monitors.length <= 1
          ? "only one display: a fullscreen projector will cover the OBS window, and nothing here can close it again. Prefer windowed."
          : "pick monitorIndex from this list; fullscreen projectors cannot be closed over the websocket.",
      };
    },
  },

  {
    name: "obs_projector_open_mix",
    description:
      "Open a projector showing a whole video mix - program (what is going out), preview (what studio mode " +
      "has queued up), or multiview (the grid of all scenes).\n\n" +
      "program on a second monitor is the standard clean-feed trick: a capture card or a second PC pointed " +
      "at that display gets the finished broadcast picture without a second encode and without OBS chrome. " +
      "preview is the confidence monitor for whoever is operating. multiview is for a director watching " +
      "everything at once.\n\n" +
      "Defaults to a WINDOW. Pass monitorIndex only when obs_monitor_list shows a display you can afford to " +
      "lose, because fullscreen covers that entire screen and " + closeNote,
    inputSchema: {
      type: "object",
      properties: {
        videoMixType: {
          type: "string",
          enum: ["program", "preview", "multiview"],
          description: "program = live output, preview = studio-mode staging, multiview = all-scenes grid.",
        },
        monitorIndex: {
          type: "number",
          description:
            "Index from obs_monitor_list for fullscreen. Omit, or use -1, for a normal window. " +
            "Mutually exclusive with projectorGeometry.",
        },
        projectorGeometry: {
          type: "string",
          description:
            "Size and position for a windowed projector, in Qt's base64 geometry format. The protocol does " +
            "not document how to construct one, so in practice this is a value copied from somewhere that " +
            "already had it - otherwise omit it and let the window open at its default size.",
        },
      },
      required: ["videoMixType"],
      additionalProperties: false,
    },
    handler: async (args = {}) => {
      const { videoMixType } = args;
      const data = { videoMixType: MIX_TYPES[videoMixType], ...placement(args) };
      await obs.request("OpenVideoMixProjector", data);
      return {
        opened: videoMixType,
        videoMixType: data.videoMixType,
        mode: args.monitorIndex !== undefined && args.monitorIndex >= 0 ? "fullscreen" : "windowed",
        ...(args.monitorIndex !== undefined ? { monitorIndex: args.monitorIndex } : {}),
        note: fullscreenWarning(args.monitorIndex) || closeNote,
      };
    },
  },

  {
    name: "obs_projector_open_source",
    description:
      "Open a projector showing ONE source on its own, rather than the whole mix. sourceName takes a scene " +
      "name as readily as an input name - in OBS a scene is a source - so this projects either a single " +
      "camera, screen capture or media input, or an entire scene composed as it would look on air.\n\n" +
      "What it is for: feeding one specific picture to hardware or to a person. A guest's camera on a " +
      "monitor they can see, one screen share to a capture card, a scene routed to a second machine - all " +
      "without re-encoding anything, because the projector is just the same frames drawn to a window.\n\n" +
      "A source projector shows that source ALONE. Overlays that live in a different scene are not in it: " +
      "on the reference machine the HUD is its own scene added into the others, so projecting a camera source gives you " +
      "the bare camera, and projecting a scene gives you that scene's own composite. If you want what the " +
      "audience sees, that is the program mix, not a source - use obs_projector_open_mix.\n\n" +
      "Defaults to a WINDOW. " + closeNote,
    inputSchema: {
      type: "object",
      properties: {
        sourceName: { type: "string", description: "Name of the input OR scene to project." },
        sourceUuid: { type: "string", description: "UUID instead of a name." },
        canvasUuid: { type: "string", description: "UUID of the canvas the source belongs to, when disambiguating by name." },
        monitorIndex: {
          type: "number",
          description:
            "Index from obs_monitor_list for fullscreen. Omit, or use -1, for a normal window. " +
            "Mutually exclusive with projectorGeometry.",
        },
        projectorGeometry: {
          type: "string",
          description:
            "Size and position for a windowed projector, in Qt's base64 geometry format. The protocol does " +
            "not document how to construct one; omit it unless you are reusing a known value.",
        },
      },
      additionalProperties: false,
    },
    handler: async (args = {}) => {
      const { sourceName, sourceUuid, canvasUuid } = args;
      if (sourceName === undefined && sourceUuid === undefined) {
        throw new Error("give sourceName or sourceUuid");
      }
      const data = { ...placement(args) };
      if (sourceName !== undefined) data.sourceName = sourceName;
      if (sourceUuid !== undefined) data.sourceUuid = sourceUuid;
      if (canvasUuid !== undefined) data.canvasUuid = canvasUuid;

      await obs.request("OpenSourceProjector", data);
      return {
        opened: sourceName || sourceUuid,
        mode: args.monitorIndex !== undefined && args.monitorIndex >= 0 ? "fullscreen" : "windowed",
        ...(args.monitorIndex !== undefined ? { monitorIndex: args.monitorIndex } : {}),
        note: fullscreenWarning(args.monitorIndex) || closeNote,
      };
    },
  },
];
