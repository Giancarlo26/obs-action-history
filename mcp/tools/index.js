"use strict";
/*
 * The tool registry.
 *
 * WHY THIS EXISTS
 *
 * obs-mcp-server.js grew to 920 lines with 23 tools in one array. That is
 * fine for a rig and wrong for a product: nobody can add a capability without
 * touching the same file as everyone else, and the file is the thing we would
 * be asking other people to fork.
 *
 * The 23 original tools DELIBERATELY STAY WHERE THEY ARE. This is additive.
 * The server concatenates what these modules return onto its own array, so the
 * behaviour that has been driving a live broadcast for eight days is not
 * rewritten in order to be tidied, and a bug in a module here cannot take the
 * working set down with it.
 *
 * CONTRACT
 *
 * Each module exports a function taking the connected client and returning an
 * array of tools:
 *
 *   module.exports = (obs) => [{
 *     name: "obs_something",
 *     description: "...",              // written for a model, not a changelog
 *     inputSchema: { ... },            // JSON Schema, additionalProperties:false
 *     handler: async (args) => obs.request("SomeRequest", { ... }),
 *   }];
 *
 * `obs.request(type, data)` is the only thing a module may use. Anything that
 * needs more than that belongs in lib/obs.js, not here.
 *
 * WRITING A DESCRIPTION
 *
 * This is the part that decides whether the tool is usable, and it is where
 * every other OBS MCP server is weakest - they wrap obs-websocket one request
 * per tool and repeat the protocol's own wording. A description should say
 * what the thing is FOR and name the trap. "Audio offset caps near 960 ms;
 * larger values apply silently as nothing" is worth more than a parameter
 * list the model can already see in the schema.
 */

const MODULES = [
  "./scene-items",
  "./filters",
  "./audio-routing",
  "./capture",
  "./studio",
  "./inputs",
  "./outputs",
  "./media",
  "./hotkeys",
  "./projector",
];

module.exports = function collect(obs, log = () => {}) {
  const out = [];
  const seen = new Set();

  for (const id of MODULES) {
    let mod;
    try {
      mod = require(id);
    } catch (e) {
      // A missing or broken module must never stop the server booting: the
      // working tools matter more than the new ones.
      if (e.code !== "MODULE_NOT_FOUND" || !String(e.message).includes(id.slice(2))) {
        log(`tool module ${id} failed to load: ${e.message}`);
      }
      continue;
    }
    let tools;
    try {
      tools = mod(obs) || [];
    } catch (e) {
      log(`tool module ${id} threw while building: ${e.message}`);
      continue;
    }
    for (const t of tools) {
      if (!t || !t.name || typeof t.handler !== "function") {
        log(`tool module ${id} returned a malformed tool, skipped`);
        continue;
      }
      if (seen.has(t.name)) {
        log(`duplicate tool name ${t.name} from ${id}, skipped`);
        continue;
      }
      seen.add(t.name);
      out.push(t);
    }
  }
  return out;
};
