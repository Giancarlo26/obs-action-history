"use strict";
/*
 * The OBS websocket password, in ONE single place.
 *
 * It used to be hardcoded in twelve files. With the repo that means
 * publishing it twelve times and, worse, that changing it forces you to touch
 * twelve files and to forget one of them.
 *
 * Order: environment variable first (handy for launching a one-off), and
 * failing that secrets.json in the root, which is in .gitignore.
 */
const fs = require("fs");
const path = require("path");

module.exports = function obsPassword() {
  if (process.env.OBS_WEBSOCKET_PASSWORD) return process.env.OBS_WEBSOCKET_PASSWORD;
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "secrets.json"), "utf8")).obsPassword;
  } catch {
    throw new Error(
      "The OBS password is missing.\n" +
      "  Create secrets.json beside server.js containing:\n" +
      "      { \"obsPassword\": \"...\" }\n" +
      "  taking the value from OBS > Tools > WebSocket Server Settings >\n" +
      "  Show Connect Info. Or set OBS_WEBSOCKET_PASSWORD instead.\n" +
      "  secrets.json is gitignored. There is deliberately no example file:\n" +
      "  a copied placeholder authenticates as itself and is refused with\n" +
      "  close code 4009, which does not look like a password problem."
    );
  }
};
