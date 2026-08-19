"use strict";
/*
 * Hotkeys - the only route to everything OBS has that obs-websocket does not.
 *
 * WHY THIS MODULE EARNS ITS PLACE
 *
 * obs-websocket exposes requests for what OBS shipped with. It exposes nothing
 * for what PLUGINS add: a plugin can register an action and a hotkey for it,
 * and unless the plugin also ships a websocket vendor request - most do not -
 * the hotkey is the entire public surface. Triggering hotkeys is therefore the
 * difference between a server that controls OBS and a server that controls OBS
 * including everything installed in it.
 *
 * Measured on the reference machine (OBS 32.2.1 / obs-websocket 5.7.4): 411 registered
 * hotkeys. 390 are core - libobs.*, OBSBasic.*, MediaSource.*, ObsBrowser.*,
 * ReplayBuffer.* - and 21 come from plugins:
 *
 *   14  VerticalCanvasDock*   vertical-canvas plugin: its own streaming,
 *                             recording, virtual cam, backtrack, chapters and
 *                             split, none of which the normal Start/Stop
 *                             requests touch, because the vertical canvas is a
 *                             second output pipeline.
 *    7  *SwitcherHotkey       Advanced Scene Switcher: start/stop/toggle the
 *                             switcher and drive macro segments.
 *
 * The other two plugins loaded here, Move Transition and NDI, register no
 * hotkeys at all - so this route reaches neither of them. That is worth
 * knowing before you go looking.
 *
 * THE COUNTERWEIGHT
 *
 * The protocol itself says hotkey support is as-is and that in 9 of 10 uses
 * there is a better, more reliable request. It is right, and the reason is
 * visible in the data: hotkey names are NOT unique. Of the 411 above, 37 names
 * are duplicated - libobs.mute exists once per audio source, and
 * libobs.show_scene_item.4 once per scene that has a fourth item. Triggering by
 * name gives you no way to say WHICH. Use SetInputMute to mute a source and
 * SetSceneItemEnabled to hide an item; reach for a hotkey when there is no
 * request, which on the reference machine means the plugin macros above.
 */

// Prefixes OBS itself registers. Anything else came from a plugin, and plugin
// actions are the reason to be in this file at all.
const CORE_PREFIXES = ["libobs.", "OBSBasic.", "MediaSource.", "ObsBrowser.", "ReplayBuffer."];
const isCore = (name) => CORE_PREFIXES.some((p) => name.startsWith(p));

// Triggering any of these by name ends or interrupts the broadcast.
const BROADCAST_ENDING = new Set([
  "OBSBasic.StopStreaming",
  "OBSBasic.ForceStopStreaming",
  "OBSBasic.StartStreaming",
  "VerticalCanvasDockStopStreaming",
  "VerticalCanvasDockStartStreaming",
]);

module.exports = (obs) => [
  {
    name: "obs_hotkey_list",
    description:
      "List the hotkey action names OBS knows about, which is how you discover what PLUGINS can do - " +
      "a plugin's actions usually have no obs-websocket request at all, so this list is their only index. " +
      "Results are grouped into core OBS actions and plugin-provided ones, and deduplicated with a count, " +
      "because the raw response on the reference machine is 411 strings of which 37 are repeats.\n\n" +
      "Pass filter to narrow by substring (case-insensitive), or pluginsOnly:true to skip the ~390 core " +
      "entries and see just what the installed plugins registered.\n\n" +
      "THE TRAP THIS LIST REVEALS: a repeated name means the action exists once per source or per scene - " +
      "libobs.mute is registered separately for every audio input - and the trigger request takes only a " +
      "name, so you cannot address a specific one. When you see count > 1 here, do not trigger it; find the " +
      "real request instead (SetInputMute, SetSceneItemEnabled, and so on). Names with count 1 that are " +
      "plugin-provided are the ones worth triggering.",
    inputSchema: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Case-insensitive substring, e.g. 'switcher' or 'vertical'." },
        pluginsOnly: {
          type: "boolean",
          description: "Only names outside libobs./OBSBasic./MediaSource./ObsBrowser./ReplayBuffer. - i.e. plugin actions.",
        },
      },
      additionalProperties: false,
    },
    handler: async ({ filter, pluginsOnly } = {}) => {
      const { hotkeys = [] } = await obs.request("GetHotkeyList", {});

      const counts = new Map();
      for (const h of hotkeys) counts.set(h, (counts.get(h) || 0) + 1);

      const needle = filter ? String(filter).toLowerCase() : null;
      const rows = [...counts.entries()]
        .filter(([name]) => (needle ? name.toLowerCase().includes(needle) : true))
        .filter(([name]) => (pluginsOnly ? !isCore(name) : true))
        .map(([name, count]) => ({
          name,
          count,
          plugin: !isCore(name),
          ...(count > 1 ? { ambiguous: "registered once per source/scene - triggering by name cannot pick one" } : {}),
          ...(BROADCAST_ENDING.has(name) ? { danger: "starts or stops a broadcast" } : {}),
        }))
        .sort((a, b) => Number(b.plugin) - Number(a.plugin) || a.name.localeCompare(b.name));

      return {
        totalRegistered: hotkeys.length,
        distinctNames: counts.size,
        pluginNames: [...counts.keys()].filter((n) => !isCore(n)).length,
        duplicatedNames: [...counts.values()].filter((c) => c > 1).length,
        hotkeys: rows,
      };
    },
  },

  {
    name: "obs_hotkey_trigger",
    description:
      "Fire an OBS hotkey action by name - the way to invoke plugin features that have no obs-websocket " +
      "request of their own. On the reference machine that means the vertical-canvas plugin's separate recording and " +
      "streaming pipeline (VerticalCanvasDock*) and Advanced Scene Switcher's start/stop and macro segments " +
      "(*SwitcherHotkey). Get names from obs_hotkey_list.\n\n" +
      "DANGEROUS NAMES ARE IN THE SAME NAMESPACE. OBSBasic.StopStreaming, OBSBasic.ForceStopStreaming and " +
      "VerticalCanvasDockStopStreaming all sit in that list and all end a live broadcast instantly; " +
      "OBSBasic.StartStreaming starts one. There is no undo and no confirmation. This tool refuses nothing, " +
      "so read the name you are about to send.\n\n" +
      "DO NOT USE IT AS A SHORTCUT FOR A REAL REQUEST. Duplicated names - libobs.mute, MediaSource.Play, " +
      "libobs.show_scene_item.N - are registered once per source or scene, and this request takes a bare " +
      "name, so which one fires is not something you control. Mute with SetInputMute, hide with " +
      "SetSceneItemEnabled, switch scenes with SetCurrentProgramScene. Hotkeys are for what those cannot reach.\n\n" +
      "OBS returns success for a name it accepted, not for an effect it produced; verify the thing you " +
      "wanted actually changed.",
    inputSchema: {
      type: "object",
      properties: {
        hotkeyName: {
          type: "string",
          description: "Exact name from obs_hotkey_list, e.g. 'VerticalCanvasDockStartRecording'. Case-sensitive.",
        },
        contextName: {
          type: "string",
          description:
            "Optional context for the hotkey, per the protocol. Note GetHotkeyList returns names only and " +
            "never contexts, so there is no way to discover a valid value here from the API - omit it unless " +
            "a plugin's own documentation gave you one.",
        },
      },
      required: ["hotkeyName"],
      additionalProperties: false,
    },
    handler: async ({ hotkeyName, contextName } = {}) => {
      const data = { hotkeyName };
      if (contextName !== undefined) data.contextName = contextName;
      await obs.request("TriggerHotkeyByName", data);
      return {
        triggered: hotkeyName,
        ...(contextName !== undefined ? { contextName } : {}),
        note: "OBS acknowledged the name; it does not report whether an action ran. Verify the effect.",
      };
    },
  },

  {
    name: "obs_hotkey_key",
    description:
      "Press a key combination at OBS, as if typed while OBS had focus. Use this only when an action has no " +
      "name in obs_hotkey_list and no request - for instance a plugin binding a user configured by hand in " +
      "Settings > Hotkeys.\n\n" +
      "It is a blunt instrument and fails silently in both directions. If nothing is bound to the " +
      "combination, OBS accepts the request and does nothing at all. If something you did not expect is " +
      "bound to it, that fires instead - and OBS's default bindings include stopping the stream and the " +
      "recording. There is no request that reports what is bound to what, so you cannot check first.\n\n" +
      "keyId values are the OBS_KEY_* identifiers from libobs/obs-hotkeys.h - OBS_KEY_F1, OBS_KEY_A, " +
      "OBS_KEY_SPACE, OBS_KEY_NUM1 and so on - not browser key names and not raw characters. Modifiers go " +
      "in keyModifiers, not in keyId.",
    inputSchema: {
      type: "object",
      properties: {
        keyId: {
          type: "string",
          description: "OBS key identifier, e.g. 'OBS_KEY_F5'. Omitted means no key is pressed, only modifiers.",
        },
        keyModifiers: {
          type: "object",
          description: "Modifier keys held during the press. Omitted entirely means none.",
          properties: {
            shift: { type: "boolean" },
            control: { type: "boolean", description: "CTRL." },
            alt: { type: "boolean" },
            command: { type: "boolean", description: "CMD, macOS only. Irrelevant on this Windows rig." },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    handler: async ({ keyId, keyModifiers } = {}) => {
      const data = {};
      if (keyId !== undefined) data.keyId = keyId;
      if (keyModifiers !== undefined) data.keyModifiers = keyModifiers;
      await obs.request("TriggerHotkeyByKeySequence", data);
      return {
        sent: data,
        note: "OBS accepts this whether or not anything is bound to the combination. Verify the effect.",
      };
    },
  },
];
