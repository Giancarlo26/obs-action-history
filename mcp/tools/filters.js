"use strict";
/*
 * Source filters - full CRUD.
 *
 * The original obs_filters could list and create, which meant a filter, once
 * added, could never be tuned, reordered, switched off or removed without
 * dropping to obs_raw. Every real use is in the tuning: a noise gate is wrong
 * until its threshold is right, and a sync delay is a number you converge on.
 *
 * Creating filters still belongs to obs_filters. Everything after creation is
 * here.
 *
 * A filter belongs to a SOURCE, not to a scene item, so it applies everywhere
 * that source appears. There is no such thing as a filter that only affects one
 * scene - if that is what you need, the per-scene knobs are transform and crop.
 * `sourceName` accepts a scene name too; scenes carry filters like any source.
 *
 * Verified against OBS 32.2.1 / obs-websocket 5.7.4, which reports 43 filter
 * kinds on the reference machine.
 */

const filterRef = (extra = {}, required = []) => ({
  type: "object",
  properties: {
    sourceName: { type: "string", description: "Input or scene the filter is on." },
    filterName: { type: "string", description: "Exact filter name, from obs_filter_get." },
    ...extra,
  },
  required: ["sourceName", "filterName", ...required],
  additionalProperties: false,
});

// The chain in processing order. Returned after every change so the caller can
// see the real state instead of trusting an ok:true.
async function chain(obs, sourceName) {
  const r = await obs.request("GetSourceFilterList", { sourceName });
  return (r.filters || [])
    .slice()
    .sort((a, b) => a.filterIndex - b.filterIndex)
    .map((f) => ({
      index: f.filterIndex,
      name: f.filterName,
      kind: f.filterKind,
      enabled: f.filterEnabled,
      settings: f.filterSettings,
    }));
}

module.exports = (obs) => [
  {
    name: "obs_filter_kinds",
    description:
      "List every filter kind this OBS install can create - 43 on the reference machine - and optionally the " +
      "default settings for one of them.\n\n" +
      "This is the honest way to find out whether a PLUGIN actually loaded, because plugin filters " +
      "only appear here once their DLL is in place: move_source_filter and its siblings come from " +
      "the Move plugin, ndi_filter from the NDI runtime. If a filter kind you expect is missing, the " +
      "plugin did not load and no amount of retrying CreateSourceFilter will help - it fails with an " +
      "invalid-kind error that reads like a typo.\n\n" +
      "Kind strings are exact and several ship as v2 alongside a legacy original " +
      "(chroma_key_filter_v2, color_filter_v2, noise_suppress_filter_v2). Prefer the v2. Pass " +
      "filterKind to also fetch that kind's defaults - though be aware OBS returns an empty object " +
      "for kinds that register no explicit defaults, which means 'nothing declared', not 'no settings'.",
    inputSchema: {
      type: "object",
      properties: {
        filterKind: { type: "string", description: "Optional: also return this kind's default settings." },
      },
      additionalProperties: false,
    },
    handler: async ({ filterKind }) => {
      const r = await obs.request("GetSourceFilterKindList");
      // 5.7.4 answers with sourceFilterKinds; older builds and some docs say
      // filterKinds. Accept both rather than return undefined on one of them.
      const kinds = r.sourceFilterKinds || r.filterKinds || [];
      if (!filterKind) return { count: kinds.length, kinds };

      // Asked about ONE kind: answer about that kind. Repeating all 43 here is
      // noise that buries the thing that was actually requested.
      if (!kinds.includes(filterKind)) {
        const stem = filterKind.replace(/_v\d+$/, "").split("_")[0];
        const near = kinds.filter((k) => k.includes(stem) || filterKind.includes(k.split("_")[0]));
        return {
          filterKind,
          available: false,
          error: `"${filterKind}" is not available in this OBS install - the plugin providing it is not loaded, or the name is wrong.`,
          didYouMean: near.length ? near : undefined,
          totalKinds: kinds.length,
        };
      }
      const d = await obs.request("GetSourceFilterDefaultSettings", { filterKind });
      return {
        filterKind,
        available: true,
        defaultSettings: d.defaultFilterSettings,
        note:
          Object.keys(d.defaultFilterSettings || {}).length
            ? undefined
            : "This kind declares no explicit defaults, which is why the object is empty - it does not mean the filter has no settings.",
        totalKinds: kinds.length,
      };
    },
  },

  {
    name: "obs_filter_get",
    description:
      "Read the filter chain on a source, or one filter in full detail. Do this before changing " +
      "anything: every other filter tool addresses filters by exact name, and the settings you get " +
      "back are the keys that actually exist for that kind.\n\n" +
      "THE SETTINGS OBJECT IS PARTIAL. OBS only reports values that DIFFER from the kind's defaults, " +
      "so a filter showing {} is running entirely on defaults, not broken and not empty. This is the " +
      "reason a compressor here reports five keys while a delay reports one. It also means you " +
      "cannot learn a kind's full parameter list from an existing filter - use obs_filter_kinds with " +
      "filterKind for the declared defaults.\n\n" +
      "Order is returned lowest index first, which is the order audio and video actually flow " +
      "through. Omit filterName for the whole chain.",
    inputSchema: {
      type: "object",
      properties: {
        sourceName: { type: "string", description: "Input or scene to inspect." },
        filterName: { type: "string", description: "Optional: one filter, in detail." },
      },
      required: ["sourceName"],
      additionalProperties: false,
    },
    handler: async ({ sourceName, filterName }) => {
      if (filterName) {
        const f = await obs.request("GetSourceFilter", { sourceName, filterName });
        return {
          sourceName,
          name: filterName,
          kind: f.filterKind,
          index: f.filterIndex,
          enabled: f.filterEnabled,
          settings: f.filterSettings,
          note: "settings holds only values that differ from this kind's defaults.",
        };
      }
      const filters = await chain(obs, sourceName);
      return { sourceName, count: filters.length, filters, note: "Processing order, index 0 first." };
    },
  },

  {
    name: "obs_filter_settings",
    description:
      "Tune a filter that already exists - the threshold on a gate, delay_ms on a sync delay, " +
      "opacity on a colour correction, similarity on a chroma key.\n\n" +
      "By default your keys are MERGED into the existing settings, so you can send one value and " +
      "leave the rest alone. Setting replace:true instead resets the filter to its kind defaults and " +
      "then applies only what you sent, silently discarding every other tuned value on that filter. " +
      "On a mic chain that has been dialled in over days, replace:true on a compressor is how you " +
      "lose the ratio, the attack and the release while only meaning to change the threshold. Use " +
      "the default merge unless you specifically want a clean slate.\n\n" +
      "Setting keys are per kind and are not validated: an unknown or misspelled key is accepted, " +
      "stored and ignored, and nothing reports an error. The response returns the filter's real " +
      "settings afterwards - compare them against what you sent, because a key that silently " +
      "vanished was the wrong name. Read obs_filter_get first to see the keys a kind really uses.\n\n" +
      "Changes apply live to a running broadcast the instant they land; there is no staging.",
    inputSchema: filterRef(
      {
        settings: { type: "object", description: "Setting keys to apply, e.g. {\"delay_ms\": 630}." },
        replace: { type: "boolean", description: "Reset to kind defaults first, discarding all other tuned values. Default false (merge)." },
      },
      ["settings"]
    ),
    handler: async ({ sourceName, filterName, settings, replace }) => {
      await obs.request("SetSourceFilterSettings", {
        sourceName,
        filterName,
        filterSettings: settings,
        // Explicit rather than relying on the protocol default: overlay true
        // merges, false resets to defaults and then applies.
        overlay: !replace,
      });
      const f = await obs.request("GetSourceFilter", { sourceName, filterName });
      const ignored = Object.keys(settings || {}).filter((k) => !(k in (f.filterSettings || {})));
      return {
        sourceName,
        filterName,
        mode: replace ? "replace (reset to defaults, then applied)" : "merge",
        settings: f.filterSettings,
        warning: ignored.length
          ? `These keys are absent from the filter after the write: ${ignored.join(", ")}. ` +
            "Either they equal the kind default, or the key name is wrong for this kind - OBS accepts unknown keys without complaining."
          : undefined,
      };
    },
  },

  {
    name: "obs_filter_toggle",
    description:
      "Switch a filter on or off without removing it. Settings are kept, so this is the reversible " +
      "way to find out what a filter is actually doing - toggle the noise suppression off, listen, " +
      "toggle it back. Reach for this instead of obs_filter_remove whenever the question is 'is this " +
      "helping', because removing loses the tuning and there is no undo.\n\n" +
      "A disabled filter stays in the chain and keeps its index, so the numbering does not shift " +
      "under you while you experiment.\n\n" +
      "The effect is immediate on the live output. Disabling a sync delay on a camera will jump that " +
      "camera out of lip-sync on stream at once, not at the next scene change.",
    inputSchema: filterRef({
      enabled: { type: "boolean", description: "true = on, false = bypassed. Omit to just read." },
    }),
    handler: async ({ sourceName, filterName, enabled }) => {
      if (enabled !== undefined)
        await obs.request("SetSourceFilterEnabled", { sourceName, filterName, filterEnabled: enabled });
      const f = await obs.request("GetSourceFilter", { sourceName, filterName });
      return { sourceName, filterName, kind: f.filterKind, enabled: f.filterEnabled };
    },
  },

  {
    name: "obs_filter_remove",
    description:
      "Delete a filter from a source, permanently. Its settings go with it and the websocket has no " +
      "undo - if you might want it back, obs_filter_toggle bypasses it instead and keeps the tuning.\n\n" +
      "Removing renumbers everything below it in the chain, so any filterIndex you noted before this " +
      "call is stale afterwards. Re-read with obs_filter_get before reordering.\n\n" +
      "Filters are per source, so this affects every scene that uses the source, not just the scene " +
      "you happen to be looking at. The response returns the chain that is left.",
    inputSchema: filterRef(),
    handler: async ({ sourceName, filterName }) => {
      const before = await obs.request("GetSourceFilter", { sourceName, filterName }).catch(() => null);
      await obs.request("RemoveSourceFilter", { sourceName, filterName });
      return {
        sourceName,
        removed: filterName,
        kind: before ? before.filterKind : undefined,
        settingsThatAreNowGone: before ? before.filterSettings : undefined,
        remaining: await chain(obs, sourceName),
      };
    },
  },

  {
    name: "obs_filter_order",
    description:
      "Move a filter within the chain. Index 0 runs FIRST, and each filter processes what the one " +
      "before it produced, so the order is a signal path and not a preference.\n\n" +
      "This is why the mic chain here reads noise suppression, then compressor, then limiter: the " +
      "compressor is levelling speech rather than chasing room hiss up and down, and the limiter has " +
      "the last word on the peaks. Put the limiter first and it clamps a signal the compressor has " +
      "not levelled yet, then the compressor raises everything back up past the ceiling the limiter " +
      "was there to hold. Video is the same idea - crop before scale, and a colour key before a " +
      "colour correction that would move the colour you are keying on.\n\n" +
      "Indexes are contiguous and renumber after every move, so read the chain again rather than " +
      "reusing numbers from before. Valid range is 0 to 8192; the resulting chain comes back.",
    inputSchema: filterRef({
      index: { type: "number", description: "New position. 0 = runs first." },
    }, ["index"]),
    handler: async ({ sourceName, filterName, index }) => {
      if (index < 0 || index > 8192)
        throw new Error(`index must be between 0 and 8192 (got ${index})`);
      await obs.request("SetSourceFilterIndex", { sourceName, filterName, filterIndex: index });
      return { sourceName, moved: filterName, toIndex: index, chain: await chain(obs, sourceName) };
    },
  },

  {
    name: "obs_filter_rename",
    description:
      "Rename a filter. The name is the only handle every other filter request has - there is no " +
      "filter id - so renaming is the one edit here that can break something outside OBS: scripts, " +
      "panel code and Move-plugin filters all address filters by exact name and will simply fail to " +
      "find the old one afterwards. On the reference machine the sync delays are named consistently and the music ducking " +
      "compressors DUCK, DUCK-IRL and so on, and tooling looks for exactly those strings.\n\n" +
      "Names must be unique per source. Renaming does not change the filter's index, its settings or " +
      "whether it is enabled.",
    inputSchema: filterRef({
      newName: { type: "string", description: "New filter name, unique within this source." },
    }, ["newName"]),
    handler: async ({ sourceName, filterName, newName }) => {
      await obs.request("SetSourceFilterName", { sourceName, filterName, newFilterName: newName });
      return { sourceName, renamed: { from: filterName, to: newName }, chain: await chain(obs, sourceName) };
    },
  },
];
