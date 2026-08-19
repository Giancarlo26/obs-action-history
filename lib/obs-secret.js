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
      "  Copy secrets.example.json to secrets.json and fill it in,\n" +
      "  or export OBS_WEBSOCKET_PASSWORD."
    );
  }
};
