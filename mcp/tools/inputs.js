"use strict";
/*
 * Inputs: the source lifecycle, and the one thing you cannot guess.
 *
 * obs_list_inputs / obs_get_input_settings / obs_set_input_settings /
 * obs_create_input already exist in the server. They all share one blind spot:
 * every one of them assumes you ALREADY KNOW the value you want to write. That
 * is fine for a rig somebody built by hand and false everywhere else, because
 * the interesting settings on Windows are opaque device strings:
 *
 *   video_device_id = "Logitech StreamCam:\\?\usb#22vid_046d&pid_0893&mi_00#..."
 *   device_id       = "{0.0.1.00000000}.{xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx}"
 *
 * Nothing can derive those. They are per-machine, and the audio one is a raw
 * GUID with no human-readable part at all. obs_input_property_items is the
 * request that hands them over, and it is why this module exists.
 *
 * Everything mutating here was written against the obs-websocket v5 protocol
 * reference and NOT executed - the rig was mid-broadcast. The read paths were
 * run against live OBS, and every property name and error string quoted in a
 * description below came back from that machine rather than from memory.
 */

/* Names below are the ones the reference machine's OBS actually answered to. Kinds not
 * present on the machine are deliberately absent rather than guessed. */
const KNOWN_LIST_PROPERTIES = [
  "dshow_input (webcam / capture card): video_device_id, audio_device_id, res_type, resolution, video_format, color_space",
  "wasapi_input_capture and wasapi_output_capture (mic / desktop audio): device_id",
  "monitor_capture (screen): monitor_id, method",
];

module.exports = (obs) => [
  {
    name: "obs_input_property_items",
    description:
      "Enumerate the real choices behind a dropdown in a source's Properties dialog - every webcam, " +
      "capture card, microphone, speaker and monitor this machine has, with the exact device ID string " +
      "OBS wants written back. This is the difference between configuring OBS on a machine somebody " +
      "already set up by hand and configuring one from nothing: without it, pointing a capture source " +
      "at a camera means GUESSING a Windows device path, and pointing an audio source at a mic means " +
      "guessing a GUID like '{0.0.1.00000000}.{xxxxxxxx-...}' that appears in no documentation and is " +
      "different on every PC. Read the list here, then write the chosen itemValue with " +
      "obs_set_input_settings under the SAME property name.\n" +
      "\n" +
      "Write back itemValue, never itemName. itemName is the label a human reads ('Logitech StreamCam'); " +
      "itemValue is the device path, and it is what OBS matches on. itemEnabled false means the device " +
      "is known to OBS but not selectable right now - typically another application holds it open.\n" +
      "\n" +
      "propertyName is the plugin's INTERNAL id, not the label in the dialog. Verified on the reference machine:\n  " +
      KNOWN_LIST_PROPERTIES.join("\n  ") + "\n" +
      "Other kinds and other plugins have their own ids; the two failure messages tell them apart. " +
      "'Unable to find a property by that name' means the id is wrong. 'The property found is not a " +
      "list' means the id is RIGHT but that property is a button, a checkbox, a path or a text box - " +
      "which is itself useful, because it is how you confirm a button exists before pressing it with " +
      "obs_press_input_button.\n" +
      "\n" +
      "These values are not portable and not permanent: a USB camera moved to a different port gets a " +
      "different video_device_id, which is the usual reason a scene that worked yesterday shows a black " +
      "rectangle today. Re-read this list rather than reusing a stored string.",
    inputSchema: {
      type: "object",
      properties: {
        inputName: {
          type: "string",
          description: "Exact existing input name, as returned by obs_list_inputs. The source must already exist - this reads the properties of an instance, not of a kind.",
        },
        propertyName: {
          type: "string",
          description: "Internal property id, e.g. 'video_device_id' for a webcam or 'device_id' for a mic.",
        },
      },
      required: ["inputName", "propertyName"],
      additionalProperties: false,
    },
    handler: async ({ inputName, propertyName }) => {
      let r;
      try {
        r = await obs.request("GetInputPropertiesListPropertyItems", { inputName, propertyName });
      } catch (e) {
        const m = String((e && e.message) || e);
        // Turn OBS's two terse messages into the next action. They look alike
        // and mean opposite things.
        if (/not a list/i.test(m)) {
          throw new Error(
            `"${propertyName}" exists on "${inputName}" but is not a dropdown, so it has no items to list. ` +
            `It is a button, checkbox, path or text field. If it is a button, press it with ` +
            `obs_press_input_button; otherwise read its current value with obs_get_input_settings.`
          );
        }
        if (/find a property/i.test(m)) {
          throw new Error(
            `"${inputName}" has no property called "${propertyName}". Property ids are internal names, ` +
            `not the labels shown in the Properties dialog. Check the input's kind with obs_list_inputs, ` +
            `then try the ids known for that kind: ${KNOWN_LIST_PROPERTIES.join("; ")}.`
          );
        }
        throw e;
      }

      const items = r.propertyItems || [];
      return {
        inputName,
        propertyName,
        count: items.length,
        // Protocol keys kept as-is so the shape matches the reference.
        items,
        usage: `To select one: obs_set_input_settings { inputName: "${inputName}", settings: { "${propertyName}": <that item's itemValue> } }. Use itemValue, not itemName.`,
        ...(items.length === 0
          ? { note: "The property is a list but currently empty - usually means no device of this type is attached." }
          : {}),
      };
    },
  },

  {
    name: "obs_press_input_button",
    description:
      "Press a button inside a source's Properties dialog. OBS exposes a handful of actions only as " +
      "buttons - there is no setting to write instead - so without this an agent simply cannot perform " +
      "them, and two of them are the standard recoveries for the reference machine:\n" +
      "\n" +
      "- 'refreshnocache' on a browser_source is the ONLY way to make OBS pick up an edited local file. " +
      "The overlays here are local HTML in overlay\\, and OBS caches them: after editing one, writing " +
      "the same url back with obs_set_input_settings is a no-op and the stream keeps showing the old " +
      "page. Verified present on the reference machine's browser sources; note the id is 'refreshnocache', not " +
      "'refresh', which does not exist.\n" +
      "- 'activate' on a dshow_input (webcam / capture card) is how you recover a camera that dropped - " +
      "the device stopped delivering frames and the source is showing black while OBS still believes it " +
      "is fine. The id is 'activate' in BOTH directions: it toggles, and the dialog only changes the " +
      "button's label to 'Deactivate'. There is no 'deactivate' property - asking for one returns " +
      "'Unable to find a property by that name'.\n" +
      "\n" +
      "Two cautions. A press on a live source is visible on stream: toggling 'activate' on a camera that " +
      "is currently on air drops it to black for as long as the device takes to re-open, and if the " +
      "device is genuinely gone it stays black and you have just deactivated a working scene - check " +
      "which scene is live first. And OBS returns nothing at all on success, so a clean result means " +
      "'the button was pressed', not 'the thing you wanted happened'; confirm with obs_screenshot.\n" +
      "\n" +
      "Buttons are not discoverable through obs_input_property_items, which only enumerates dropdowns. " +
      "What that tool does give you is existence: 'The property found is not a list' confirms the id is " +
      "real before you press it, while 'Unable to find a property by that name' means it is not.",
    inputSchema: {
      type: "object",
      properties: {
        inputName: { type: "string", description: "Exact input name, as returned by obs_list_inputs." },
        propertyName: {
          type: "string",
          description: "Internal button id, e.g. 'refreshnocache' on a browser_source or 'activate' on a dshow_input.",
        },
      },
      required: ["inputName", "propertyName"],
      additionalProperties: false,
    },
    handler: async ({ inputName, propertyName }) => {
      try {
        await obs.request("PressInputPropertiesButton", { inputName, propertyName });
      } catch (e) {
        const m = String((e && e.message) || e);
        if (/find a property/i.test(m)) {
          throw new Error(
            `"${inputName}" has no button called "${propertyName}". Common ids: 'refreshnocache' ` +
            `(browser_source, reload ignoring cache), 'activate' (dshow_input, toggle the device). ` +
            `Confirm an id exists by calling obs_input_property_items with it - "The property found is ` +
            `not a list" means it exists and is not a dropdown, which is what a button looks like.`
          );
        }
        throw e;
      }
      return {
        ok: true,
        inputName,
        propertyName,
        note: "OBS acknowledges the press but reports no outcome. Verify with obs_screenshot before treating this as done.",
      };
    },
  },

  {
    name: "obs_remove_input",
    description:
      "Delete a source outright, removing it from every scene it appears in at once.\n" +
      "\n" +
      "The trap: a clean result does NOT prove the source is gone. OBS drops its own reference and " +
      "answers success, but the source itself survives as long as anything else still holds a reference " +
      "to it - and those references are not all visible from the scene list. A plugin that maintains a " +
      "second canvas (the vertical-canvas plugin on the reference machine does exactly that) keeps its own reference, " +
      "so the input can vanish from obs_list_inputs while the decoder is still running and still costing " +
      "GPU. If you removed something to reclaim resources and the machine did not get faster, this is " +
      "why. This tool re-reads the input list afterwards and tells you which of the two happened.\n" +
      "\n" +
      "So if the goal is to stop something DECODING rather than to delete it, do not use this at all: " +
      "take it out of every scene, or hide it. A source that is in no active scene does not decode and " +
      "does not burn GPU, and it is reversible - which matters here, because removal is not undoable " +
      "over the websocket. Re-creating the input afterwards will not bring back its filters, its audio " +
      "routing, its sync offset, or its position and crop in any scene. Read obs_get_input_settings " +
      "first if there is any chance you will need to rebuild it.",
    inputSchema: {
      type: "object",
      properties: {
        inputName: {
          type: "string",
          description: "Exact input name. Removal is permanent and affects every scene containing it.",
        },
      },
      required: ["inputName"],
      additionalProperties: false,
    },
    handler: async ({ inputName }) => {
      await obs.request("RemoveInput", { inputName });
      // Verify rather than trust the ack - the whole point of this tool.
      const after = await obs.request("GetInputList").catch(() => ({}));
      const names = (after.inputs || []).map((i) => i.inputName);
      const stillListed = names.includes(inputName);
      return {
        ok: true,
        inputName,
        stillListed,
        note: stillListed
          ? "OBS accepted the removal but the input is STILL in the input list - something holds a reference to it. It is not gone and it may still be decoding."
          : "Gone from the input list. Note this proves OBS released its reference, not that every plugin did; if you removed it to free GPU, confirm with the usual load check.",
      };
    },
  },

  {
    name: "obs_rename_input",
    description:
      "Rename a source. Inside OBS this is safe and complete: scene items reference the source itself, " +
      "not its name, so every scene follows the rename and nothing breaks visually.\n" +
      "\n" +
      "Outside OBS it is the opposite, and that is the real risk. Everything that automates OBS " +
      "addresses sources BY NAME over the websocket - health checks asking whether a mic is producing " +
      "sound, audio tooling, scene builders, and every tool call in this server. " +
      "None of them are updated by a rename, none of them fail loudly, and the symptom arrives later as " +
      "'that check stopped reporting' rather than as an error. A source name that has drifted from " +
      "what it now shows is often still worth keeping for exactly this reason. Prefer renaming the " +
      "SCENE, which nothing addresses by name, or " +
      "leaving it alone.\n" +
      "\n" +
      "Names are unique across the whole collection, so a rename onto a name already in use fails.",
    inputSchema: {
      type: "object",
      properties: {
        inputName: { type: "string", description: "Current exact input name." },
        newInputName: { type: "string", description: "New name. Must not already be in use by another input." },
      },
      required: ["inputName", "newInputName"],
      additionalProperties: false,
    },
    handler: async ({ inputName, newInputName }) => {
      await obs.request("SetInputName", { inputName, newInputName });
      const after = await obs.request("GetInputList").catch(() => ({}));
      const names = (after.inputs || []).map((i) => i.inputName);
      return {
        ok: true,
        from: inputName,
        to: newInputName,
        renamed: names.includes(newInputName) && !names.includes(inputName),
        note: "Scenes followed the rename automatically. Anything OUTSIDE OBS that referred to the old name did not - check the tools and overlays that address this source.",
      };
    },
  },

  {
    name: "obs_input_kind_reference",
    description:
      "What source types this OBS build supports, and which settings keys each type legally accepts.\n" +
      "\n" +
      "Call it with no arguments to list the kinds - that list is also the honest answer to 'which " +
      "plugins are loaded', since a kind like 'ndi_source' only appears if its plugin initialised. Call " +
      "it with inputKind to get that kind's default settings object, which is the closest thing to a " +
      "schema OBS offers: an input's kind decides which settings keys mean anything, and a key that " +
      "belongs to a different kind is accepted and silently ignored rather than rejected. That silent " +
      "acceptance is why guessing keys wastes so much time - obs_set_input_settings returns success " +
      "either way.\n" +
      "\n" +
      "Two limits worth knowing. The defaults object lists only keys the plugin registered a default " +
      "for, so it is a floor and not the full set: dshow_input returns nine keys and video_device_id is " +
      "not among them, because it has no sensible default. To see the rest, read a WORKING input of the " +
      "same kind with obs_get_input_settings, and get legal values for the dropdown keys from " +
      "obs_input_property_items. Second, kind ids carry version suffixes - this build reports " +
      "color_source_v3, text_gdiplus_v3, slideshow_v2 - and the versioned id is what existing inputs " +
      "report and what obs_create_input expects. unversioned:true strips the suffixes, which is useful " +
      "for recognising a kind named in an older config or article, but do not create sources with the " +
      "stripped names.",
    inputSchema: {
      type: "object",
      properties: {
        inputKind: {
          type: "string",
          description: "Omit to list all kinds. Give a versioned kind id (e.g. 'dshow_input', 'color_source_v3') to get that kind's default settings.",
        },
        unversioned: {
          type: "boolean",
          description: "Only affects the list. true strips version suffixes (color_source_v3 -> color_source). Default false, which is the form obs_create_input wants.",
        },
      },
      additionalProperties: false,
    },
    handler: async ({ inputKind, unversioned }) => {
      const list = await obs.request("GetInputKindList", { unversioned: !!unversioned });
      const kinds = list.inputKinds || [];

      if (!inputKind) {
        return {
          unversioned: !!unversioned,
          count: kinds.length,
          inputKinds: kinds,
          note: "Pass one of these as inputKind to see the settings keys it accepts.",
        };
      }

      // Guessing a kind id is the common failure. Say so before OBS does.
      if (!unversioned && kinds.length && !kinds.includes(inputKind)) {
        const stem = inputKind.replace(/_v\d+$/, "");
        const near = kinds.filter((k) => k.replace(/_v\d+$/, "") === stem);
        throw new Error(
          `"${inputKind}" is not a kind this OBS supports.` +
          (near.length ? ` Did you mean ${near.join(" or ")}? Version suffixes are part of the id.` : "") +
          ` Call this tool with no arguments for the full list.`
        );
      }

      const d = await obs.request("GetInputDefaultSettings", { inputKind });
      const settings = d.defaultInputSettings || {};
      return {
        inputKind,
        defaultInputSettings: settings,
        keysWithDefaults: Object.keys(settings),
        note: "These are only the keys with registered defaults, not every legal key. For the rest, read an existing input of this kind with obs_get_input_settings; for the dropdown keys' legal values, use obs_input_property_items.",
      };
    },
  },
];
