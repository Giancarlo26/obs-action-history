"use strict";
/*
 * Studio mode - the review step.
 *
 * This is the most important module in the set and the least obviously so.
 *
 * Without studio mode, an automated producer has exactly one motion available:
 * change the program scene. That motion is unreviewable. Whatever the scene
 * looks like - a camera that has not reconnected, a screen share still showing
 * a password manager, a layout that was correct an hour ago - goes to every
 * viewer on every platform the instant the request lands, and the first
 * feedback anyone gets is from chat.
 *
 * Studio mode splits that into two: stage the scene into PREVIEW, look at it
 * with a screenshot, and only then cut. An agent that can see what it is about
 * to do before doing it is a different class of thing from one that cannot,
 * and the whole difference is these three requests.
 *
 * The rail is opt-in, and it does not hold by itself: with studio mode on,
 * SetCurrentProgramScene STILL cuts straight to air. Studio mode adds a safe
 * path, it does not remove the unsafe one.
 */

const CODE_HELP = {
  505: "studio mode is active and must be off for this",
  506: "studio mode is not enabled - enable it with obs_studio_mode first",
  600: "no scene by that name - check obs_list_scenes for the exact spelling",
};

const explain = (e) => {
  const m = /code (\d+)/.exec(e.message || "");
  const help = m && CODE_HELP[m[1]];
  return help ? new Error(`${e.message} - ${help}`) : e;
};

module.exports = (obs) => [
  {
    name: "obs_studio_mode",
    description:
      "Read or set whether OBS is in studio mode - the two-stage layout where a scene can be staged " +
      "in PREVIEW and inspected before it is cut to PROGRAM. " +
      "This is the safety rail for anything automated. Switching scenes on a live broadcast is " +
      "otherwise unreviewable: the request lands and every viewer sees the result before you do. With " +
      "studio mode on, the sequence becomes stage -> screenshot the preview -> cut, and a camera that " +
      "has not reconnected or a screen share showing the wrong window gets caught by you rather than " +
      "by chat. If you are going to move scenes automatically, turn this on first. " +
      "Turning it on or off changes NOTHING that viewers see - program keeps playing throughout, so " +
      "this is safe to enable mid-broadcast. What it does change is the operator's OBS window, which " +
      "matters if a human is also driving. " +
      "TRAPS: (1) It is not a lock. With studio mode on, obs_switch_scene / SetCurrentProgramScene " +
      "still cuts straight to air with no review. Studio mode ADDS the reviewed path; it does not " +
      "close the unreviewed one. (2) Disabling it throws away whatever was staged in preview, " +
      "silently. (3) Every preview request fails with code 506 while this is off, which is the single " +
      "most common reason those tools appear broken.",
    inputSchema: {
      type: "object",
      properties: {
        enabled: {
          type: "boolean",
          description: "Omit to just read. true = enable studio mode, false = disable.",
        },
      },
      additionalProperties: false,
    },
    handler: async ({ enabled }) => {
      if (enabled !== undefined) {
        try {
          await obs.request("SetStudioModeEnabled", { studioModeEnabled: enabled });
        } catch (e) {
          throw explain(e);
        }
      }
      const r = await obs.request("GetStudioModeEnabled");
      const preview =
        r.studioModeEnabled &&
        (await obs.request("GetCurrentPreviewScene").catch(() => ({})));

      return {
        studioModeEnabled: r.studioModeEnabled,
        previewScene: preview ? preview.sceneName : null,
        changed: enabled === undefined ? false : true,
        note: r.studioModeEnabled
          ? "Preview is available. Stage with obs_preview_scene, check it with a screenshot of the " +
            "preview scene, then cut with obs_studio_transition. Note that switching the program " +
            "scene directly still bypasses all of that."
          : "No preview stage. Every scene change goes straight to air unreviewed, and all preview " +
            "requests will fail with code 506.",
      };
    },
  },

  {
    name: "obs_preview_scene",
    description:
      "Read or set the scene sitting in PREVIEW - staged, rendering, and not on air. " +
      "Setting this is the safe half of a scene change: nothing viewers see moves, so it is the one " +
      "scene operation that is genuinely harmless during a live broadcast. Stage here, screenshot the " +
      "scene by name to confirm the cameras are alive and the layout is right, then cut with " +
      "obs_studio_transition. " +
      "TRAPS: (1) Requires studio mode. With it off, both reading and setting fail with a bare code " +
      "506 that says nothing useful - this tool translates it, but the fix is always obs_studio_mode " +
      "first. (2) Staging does not guarantee a feed is connected. Network sources - SRT, RTMP, NDI - " +
      "accept a new connection only while they are being rendered, and how long that handshake takes " +
      "is not something the preview tells you. Stage early, then confirm with a screenshot of the " +
      "preview scene rather than assuming a staged source is a live one. " +
      "(3) A staged scene is not frozen. It keeps updating, so a preview screenshot taken thirty " +
      "seconds ago is not evidence about now. (4) Preview and program swap places after a transition, " +
      "so whatever you just cut away from is now sitting in preview.",
    inputSchema: {
      type: "object",
      properties: {
        sceneName: {
          type: "string",
          description: "Omit to just read. Exact scene name from obs_list_scenes.",
        },
      },
      additionalProperties: false,
    },
    handler: async ({ sceneName }) => {
      if (sceneName !== undefined) {
        try {
          await obs.request("SetCurrentPreviewScene", { sceneName });
        } catch (e) {
          throw explain(e);
        }
      }
      let preview;
      try {
        preview = await obs.request("GetCurrentPreviewScene");
      } catch (e) {
        throw explain(e);
      }
      const program = await obs.request("GetCurrentProgramScene").catch(() => ({}));

      return {
        previewScene: preview.sceneName,
        programScene: program.sceneName || program.currentProgramSceneName,
        onAir: false,
        note:
          "Nothing viewers see has changed. Screenshot this scene by name to check it, then " +
          "obs_studio_transition to put it on air.",
      };
    },
  },

  {
    name: "obs_studio_transition",
    description:
      "CUT TO AIR. Runs the current transition, taking whatever is in preview to program. This is the " +
      "irreversible half of a studio-mode scene change and the moment every viewer on every platform " +
      "sees the new scene - treat it exactly as seriously as switching the program scene directly, " +
      "because that is what it does. Read obs_preview_scene and look at a screenshot of it before " +
      "calling this. " +
      "TRAPS: (1) Requires studio mode; code 506 otherwise. (2) It returns immediately, BEFORE the " +
      "transition finishes. With a fade or a stinger configured, program is mid-transition when this " +
      "resolves, so a screenshot taken right after shows a blend of two scenes rather than the new " +
      "one. Wait out the transition duration before verifying. (3) It uses whatever transition and " +
      "duration OBS currently has selected - this request takes no parameters and cannot override " +
      "them. Check the current transition first if the timing matters. (4) Preview and program swap, " +
      "so calling it twice in a row returns you to the scene you started from, which looks like it " +
      "did nothing.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => {
      let before = {};
      try {
        before = await obs.request("GetCurrentPreviewScene");
      } catch (e) {
        throw explain(e);
      }
      try {
        await obs.request("TriggerStudioModeTransition");
      } catch (e) {
        throw explain(e);
      }
      const [program, preview] = await Promise.all([
        obs.request("GetCurrentProgramScene").catch(() => ({})),
        obs.request("GetCurrentPreviewScene").catch(() => ({})),
      ]);

      return {
        cutToAir: before.sceneName,
        programScene: program.sceneName || program.currentProgramSceneName,
        previewScene: preview.sceneName,
        note:
          "The transition may still be running - this request returns before it completes. " +
          "Wait out the transition duration before screenshotting to verify, and note that " +
          "preview now holds the scene you just cut away from.",
      };
    },
  },
];
