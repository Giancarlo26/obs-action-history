"use strict";
/*
 * Scene items - the composition layer.
 *
 * The server could already INSPECT a scene and nudge a source around, but it
 * could not build one or repair one: no way to add an existing source to a
 * scene, no way to remove or duplicate an item, no way to touch z-order, and a
 * transform tool exposing 8 of the 15 writable fields. Everything a HUD builder
 * actually needs was missing.
 *
 * A "scene item" is one PLACEMENT of a source inside a scene, identified by a
 * sceneItemId that is unique to that scene only. The same input appears as a
 * different scene item, with its own id, transform, visibility and lock, in
 * every scene that uses it. Change the input (its device, its URL, its filters)
 * and every scene sees it; change the scene item and only that scene does.
 *
 * Verified against OBS 32.2.1 / obs-websocket 5.7.4.
 */

const sceneItem = (extra = {}, required = []) => ({
  type: "object",
  properties: {
    sceneName: { type: "string", description: "Scene holding the item." },
    sceneItemId: { type: "number", description: "Item id from obs_list_sources_in_scene. Unique within this scene only." },
    ...extra,
  },
  required: ["sceneName", "sceneItemId", ...required],
  additionalProperties: false,
});

// Field names and clamps are lifted from the obs-websocket request handler,
// which rejects out-of-range values outright. Catching it here says which
// field and what the limit is; OBS just answers "request field out of range".
const WRITABLE = {
  positionX: null,
  positionY: null,
  scaleX: null,
  scaleY: null,
  rotation: [-360, 360],
  alignment: [0, 4294967295],
  boundsType: null,
  boundsWidth: [1, 90001],
  boundsHeight: [1, 90001],
  boundsAlignment: [0, 4294967295],
  cropToBounds: null,
  cropLeft: [0, 100000],
  cropRight: [0, 100000],
  cropTop: [0, 100000],
  cropBottom: [0, 100000],
};

const BOUNDS_TYPES = [
  "OBS_BOUNDS_NONE",
  "OBS_BOUNDS_STRETCH",
  "OBS_BOUNDS_SCALE_INNER",
  "OBS_BOUNDS_SCALE_OUTER",
  "OBS_BOUNDS_SCALE_TO_WIDTH",
  "OBS_BOUNDS_SCALE_TO_HEIGHT",
  "OBS_BOUNDS_MAX_ONLY",
];

const BLEND_MODES = [
  "OBS_BLEND_NORMAL",
  "OBS_BLEND_ADDITIVE",
  "OBS_BLEND_SUBTRACT",
  "OBS_BLEND_SCREEN",
  "OBS_BLEND_MULTIPLY",
  "OBS_BLEND_LIGHTEN",
  "OBS_BLEND_DARKEN",
];

// The stack, bottom first, the way SetSceneItemIndex numbers it - NOT the way
// the OBS window lists it. Returned after every reorder so the caller can see
// the result instead of trusting an ok:true.
async function stack(obs, sceneName) {
  const r = await obs.request("GetSceneItemList", { sceneName });
  return (r.sceneItems || [])
    .slice()
    .sort((a, b) => a.sceneItemIndex - b.sceneItemIndex)
    .map((i) => ({
      index: i.sceneItemIndex,
      itemId: i.sceneItemId,
      sourceName: i.sourceName,
      visible: i.sceneItemEnabled,
      locked: i.sceneItemLocked,
    }));
}

module.exports = (obs) => [
  {
    name: "obs_scene_item_add",
    description:
      "Add an EXISTING source to a scene, as a new scene item. This is the missing half of " +
      "obs_create_input: that one makes a brand new source, this one places a source you already " +
      "have into another scene. Reusing a source is almost always what you want - one camera placed " +
      "in six scenes is one device opened once, while six separate inputs on the same webcam will " +
      "fight over the device and most will fail to start.\n\n" +
      "A scene can be added to another scene this way, which is how layer scenes work: on the reference machine " +
      "the HUD scene holds every overlay and is added as a SINGLE item into each scene, so editing " +
      "HUD once changes all of them. Do not rebuild overlays per scene.\n\n" +
      "The new item lands at the TOP of the z-order and covers whatever it overlaps. If you are " +
      "adding a background it has to be moved down to index 0 afterwards with obs_scene_item_order. " +
      "The response reports the index it actually received, so check it rather than assuming.\n\n" +
      "sceneItemEnabled defaults to true. Note that a source can be enabled but sitting off-canvas: " +
      "see obs_scene_item_transform for why that is not the same as hidden.",
    inputSchema: {
      type: "object",
      properties: {
        sceneName: { type: "string", description: "Scene to add the source to." },
        sourceName: { type: "string", description: "Name of an existing input or scene (obs_list_inputs / obs_list_scenes)." },
        enabled: { type: "boolean", description: "Start visible. Default true." },
      },
      required: ["sceneName", "sourceName"],
      additionalProperties: false,
    },
    handler: async ({ sceneName, sourceName, enabled }) => {
      const r = await obs.request("CreateSceneItem", {
        sceneName,
        sourceName,
        sceneItemEnabled: enabled === undefined ? true : enabled,
      });
      const idx = await obs.request("GetSceneItemIndex", {
        sceneName,
        sceneItemId: r.sceneItemId,
      });
      return {
        sceneName,
        sourceName,
        itemId: r.sceneItemId,
        index: idx.sceneItemIndex,
        note:
          "Index 0 is the bottom of the stack. A new item is placed on top; move it with " +
          "obs_scene_item_order if it needs to sit under something.",
      };
    },
  },

  {
    name: "obs_scene_item_remove",
    description:
      "Remove one scene item from its scene.\n\n" +
      "This removes the PLACEMENT, not the source. The same input placed in other scenes keeps " +
      "working there, keeps its settings and keeps its filters - so deleting a camera from the BRB " +
      "scene does not disturb it anywhere else. Only when you remove the last placement does the " +
      "input itself lose its last reference, and its settings go with it, so the final copy is the " +
      "one to think twice about.\n\n" +
      "There is no undo over the websocket. If the goal is just to get something off screen, " +
      "obs_set_source_visible is reversible and this is not.",
    inputSchema: sceneItem(),
    handler: async ({ sceneName, sceneItemId }) => {
      // Read first: after removal the id is gone and there is no way to say
      // WHAT was removed, which makes the result useless in a transcript.
      const before = await stack(obs, sceneName);
      const item = before.find((i) => i.itemId === sceneItemId);
      await obs.request("RemoveSceneItem", { sceneName, sceneItemId });
      return {
        removed: item ? item.sourceName : `item ${sceneItemId}`,
        fromScene: sceneName,
        remaining: await stack(obs, sceneName),
      };
    },
  },

  {
    name: "obs_scene_item_duplicate",
    description:
      "Copy a scene item, with its transform, crop and blend mode intact, either within the same " +
      "scene or into another one. Omit toScene to duplicate in place.\n\n" +
      "The copy points at the SAME underlying source - this clones the placement, not the camera. " +
      "That is what makes it the fast way to build a matching layout: place one screen capture " +
      "exactly, duplicate it into the next scene, then move only what differs. It is also why " +
      "duplicating an audio-carrying source needs care, because you now have two items playing the " +
      "same audio in one scene and the result is doubled, not louder.\n\n" +
      "Duplicating into a scene that already has that source is allowed; OBS does not deduplicate.",
    inputSchema: sceneItem({
      toScene: { type: "string", description: "Destination scene. Omit to duplicate into the same scene." },
    }),
    handler: async ({ sceneName, sceneItemId, toScene }) => {
      const data = { sceneName, sceneItemId };
      if (toScene) data.destinationSceneName = toScene;
      const r = await obs.request("DuplicateSceneItem", data);
      const dest = toScene || sceneName;
      const idx = await obs.request("GetSceneItemIndex", {
        sceneName: dest,
        sceneItemId: r.sceneItemId,
      });
      return { scene: dest, newItemId: r.sceneItemId, index: idx.sceneItemIndex, stack: await stack(obs, dest) };
    },
  },

  {
    name: "obs_scene_item_order",
    description:
      "Read or change z-order - which source is drawn on top of which.\n\n" +
      "INDEX 0 IS THE BOTTOM. Higher index draws later, so it covers everything below it. This is " +
      "upside down from the OBS window, which lists the topmost source first, and getting it " +
      "backwards is the single easiest way to make a layer vanish.\n\n" +
      "On the reference machine the BG layer is deliberately parked at index 0 of every scene so no scene is ever " +
      "pure black. Anything full-canvas and opaque placed above it hides it completely and the " +
      "symptom is simply a black background with no error anywhere - two opaque black rectangles had " +
      "to be hidden before BG showed at all. If a background stopped showing, check what is above it " +
      "before you touch the background itself.\n\n" +
      "Call with sceneName only to read the whole stack bottom-first. Add sceneItemId and index to " +
      "move one item; the full resulting order comes back either way. Indexes are renumbered " +
      "contiguously after a move, so read the stack again before a second move rather than reusing " +
      "the numbers you just saw.",
    inputSchema: {
      type: "object",
      properties: {
        sceneName: { type: "string", description: "Scene to read or reorder." },
        sceneItemId: { type: "number", description: "Item to move. Omit to only read the order." },
        index: { type: "number", description: "New index. 0 = bottom. Requires sceneItemId." },
      },
      required: ["sceneName"],
      additionalProperties: false,
    },
    handler: async ({ sceneName, sceneItemId, index }) => {
      if (index !== undefined && sceneItemId === undefined)
        throw new Error("index needs sceneItemId - which item should move?");

      if (sceneItemId !== undefined && index === undefined) {
        const r = await obs.request("GetSceneItemIndex", { sceneName, sceneItemId });
        return { sceneName, sceneItemId, index: r.sceneItemIndex, stack: await stack(obs, sceneName) };
      }

      if (sceneItemId !== undefined) {
        await obs.request("SetSceneItemIndex", { sceneName, sceneItemId, sceneItemIndex: index });
      }
      return {
        sceneName,
        moved: sceneItemId !== undefined ? { sceneItemId, toIndex: index } : null,
        note: "Bottom first. Index 0 renders underneath everything else.",
        stack: await stack(obs, sceneName),
      };
    },
  },

  {
    name: "obs_scene_item_lock",
    description:
      "Lock or unlock a scene item. A locked item cannot be dragged or resized in the OBS window by " +
      "a human, and cannot be transformed over the websocket either - SetSceneItemTransform on a " +
      "locked item fails rather than silently doing nothing.\n\n" +
      "Worth using on the pieces that must not drift: a HUD layer or a background that someone might " +
      "grab by accident while adjusting a camera on top of it. Locking changes nothing about what " +
      "viewers see - it affects editing only, not visibility and not audio. If a transform keeps " +
      "being rejected, read the lock state before assuming the coordinates were wrong.\n\n" +
      "Omit `locked` to read the current state without changing it.",
    inputSchema: sceneItem({
      locked: { type: "boolean", description: "true = lock, false = unlock. Omit to just read." },
    }),
    handler: async ({ sceneName, sceneItemId, locked }) => {
      if (locked !== undefined)
        await obs.request("SetSceneItemLocked", { sceneName, sceneItemId, sceneItemLocked: locked });
      const r = await obs.request("GetSceneItemLocked", { sceneName, sceneItemId });
      return { sceneName, sceneItemId, locked: r.sceneItemLocked };
    },
  },

  {
    name: "obs_scene_item_blend_mode",
    description:
      "Read or set how a scene item composites with the layers under it.\n\n" +
      "OBS_BLEND_NORMAL is plain alpha and is the default. OBS_BLEND_ADDITIVE and OBS_BLEND_SCREEN " +
      "both drop black toward transparent, which is the usual trick for glows, light leaks and " +
      "particle or scanline overlays shot on a black field - they let an overlay sit on top without " +
      "boxing off what is underneath. OBS_BLEND_MULTIPLY and OBS_BLEND_DARKEN do the opposite and " +
      "drop white, useful for shadowing or tinting a region. SUBTRACT and LIGHTEN are situational.\n\n" +
      "Blend mode only matters against what is BELOW the item, so it interacts directly with " +
      "z-order: the same overlay set to additive looks completely different depending on its index. " +
      "An item at index 0 has nothing under it to blend with and will look unchanged no matter what " +
      "mode you pick - if a blend mode appears to do nothing, check the index first.\n\n" +
      "Omit `blendMode` to read the current one.",
    inputSchema: sceneItem({
      blendMode: { type: "string", enum: BLEND_MODES, description: "Blend mode to apply. Omit to just read." },
    }),
    handler: async ({ sceneName, sceneItemId, blendMode }) => {
      if (blendMode !== undefined)
        await obs.request("SetSceneItemBlendMode", { sceneName, sceneItemId, sceneItemBlendMode: blendMode });
      const r = await obs.request("GetSceneItemBlendMode", { sceneName, sceneItemId });
      return { sceneName, sceneItemId, blendMode: r.sceneItemBlendMode };
    },
  },

  {
    name: "obs_scene_item_transform",
    description:
      "The complete transform: position, scale, rotation, alignment, crop and bounds. " +
      "obs_set_source_transform covers position, scale and crop only; this one reaches the rest. " +
      "Call with just sceneName and sceneItemId to READ the current transform, including the " +
      "read-only width/height/sourceWidth/sourceHeight that tell you how big the thing actually is " +
      "on canvas right now.\n\n" +
      "Only the fields you pass change; everything else keeps its current value.\n\n" +
      "BOUNDS ARE INERT WITHOUT boundsType. boundsWidth, boundsHeight and boundsAlignment are " +
      "ignored while boundsType is OBS_BOUNDS_NONE, which is the default, so setting a bounding box " +
      "and nothing else accomplishes nothing at all and reports success. Set boundsType in the same " +
      "call. Bounds are the right tool for a slot of fixed size - OBS_BOUNDS_SCALE_INNER fits the " +
      "source inside the box keeping its aspect ratio, which is how you drop a camera of unknown " +
      "resolution into a layout without doing the arithmetic. Once bounds are active they drive the " +
      "size and scaleX/scaleY stop being the thing to adjust.\n\n" +
      "ALIGNMENT IS A BITMASK, NOT AN ENUM: 0 centre, 1 left, 2 right, 4 top, 8 bottom, added " +
      "together. 5 is top-left and is what every item on the reference machine uses. It sets which point of the " +
      "source positionX/positionY actually refers to, so changing alignment alone appears to teleport " +
      "the source even though position never changed.\n\n" +
      "Crop is measured in SOURCE pixels, before scaling, and cuts in from each edge. " +
      "width/height/sourceWidth/sourceHeight cannot be written - to resize, set scale, or use bounds.\n\n" +
      "A source moved off the canvas is still ENABLED and still renders and, more to the point, its " +
      "audio still plays. Parking something at x=2600 on a 1920 canvas does not silence it. That is " +
      "what doubled both voices on day one, from a phone parked out of frame but unmuted; it is also " +
      "used deliberately here, because the mic and music sources are off-canvas precisely so they " +
      "stay audible without taking up pixels. Hiding a source with obs_set_source_visible DOES cut " +
      "its audio, which is why those are parked rather than hidden. Choose the one you mean.",
    inputSchema: sceneItem({
      positionX: { type: "number", description: "Canvas x of the alignment point." },
      positionY: { type: "number", description: "Canvas y of the alignment point." },
      scaleX: { type: "number", description: "Horizontal scale. 1 = native size. Negative flips." },
      scaleY: { type: "number", description: "Vertical scale. 1 = native size. Negative flips." },
      rotation: { type: "number", description: "Degrees clockwise, -360 to 360." },
      alignment: { type: "number", description: "Bitmask: 0 centre, 1 left, 2 right, 4 top, 8 bottom. 5 = top-left." },
      boundsType: { type: "string", enum: BOUNDS_TYPES, description: "Required for any bounds field to take effect." },
      boundsWidth: { type: "number", description: "Bounding box width, 1 to 90001. Needs boundsType." },
      boundsHeight: { type: "number", description: "Bounding box height, 1 to 90001. Needs boundsType." },
      boundsAlignment: { type: "number", description: "Same bitmask as alignment; where the source sits inside the box. 0 = centred." },
      cropToBounds: { type: "boolean", description: "Clip anything overflowing the bounding box. Needs boundsType." },
      cropLeft: { type: "number", description: "Source pixels cut from the left, 0 to 100000." },
      cropRight: { type: "number", description: "Source pixels cut from the right." },
      cropTop: { type: "number", description: "Source pixels cut from the top." },
      cropBottom: { type: "number", description: "Source pixels cut from the bottom." },
    }),
    handler: async ({ sceneName, sceneItemId, ...args }) => {
      const current = await obs.request("GetSceneItemTransform", { sceneName, sceneItemId });

      const transform = {};
      for (const [key, range] of Object.entries(WRITABLE)) {
        const v = args[key];
        if (v === undefined) continue;
        if (range && (v < range[0] || v > range[1]))
          throw new Error(`${key} must be between ${range[0]} and ${range[1]} (got ${v}); OBS rejects the whole request otherwise`);
        transform[key] = v;
      }

      if (!Object.keys(transform).length)
        return { sceneName, sceneItemId, transform: current.sceneItemTransform, readOnly: true };

      await obs.request("SetSceneItemTransform", { sceneName, sceneItemId, sceneItemTransform: transform });
      const after = await obs.request("GetSceneItemTransform", { sceneName, sceneItemId });

      // The bounds trap, caught at the point where it happens instead of being
      // left for someone to notice on stream: bounds fields are accepted and
      // then ignored unless a boundsType is active.
      const warnings = [];
      const touchedBounds = ["boundsWidth", "boundsHeight", "boundsAlignment", "cropToBounds"].some((k) => k in transform);
      const effectiveBounds = transform.boundsType || current.sceneItemTransform.boundsType;
      if (touchedBounds && effectiveBounds === "OBS_BOUNDS_NONE")
        warnings.push(
          "boundsType is OBS_BOUNDS_NONE, so the bounds fields in this call did nothing. " +
          "Set boundsType (e.g. OBS_BOUNDS_SCALE_INNER) for them to apply."
        );

      return {
        sceneName,
        sceneItemId,
        applied: transform,
        transform: after.sceneItemTransform,
        warnings: warnings.length ? warnings : undefined,
      };
    },
  },
];
