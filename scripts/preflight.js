#!/usr/bin/env node
"use strict";
/*
 * Refuse to publish a repo that has picked up one machine's identity.
 *
 * This project was extracted from a working production rig, and the value it
 * carries is that rig's measurements. The risk that comes with that is the
 * rig's NAMES: a channel, a person, a scene, a device GUID, an absolute path.
 * None of them fail loudly for somebody else - they are simply wrong, and
 * they look authoritative enough to be copied.
 *
 * So the check is automated rather than a habit. Run it before every push:
 *
 *   npm run preflight
 *
 * It exits non-zero on the first category that fails, and prints the file and
 * line so the fix is obvious.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SKIP_DIRS = new Set([".git", "node_modules", "scripts"]);
/*
 * Read by extension, by leading dot, OR by exact name. The third case is
 * not decoration: LICENSE has no extension and does not start with a dot,
 * so an earlier version of this file never opened it, and a real first name
 * sat in the copyright line through a full green run of every check.
 * Extensionless files are exactly where attribution lives.
 */
const TEXT = /\.(js|json|md|txt|yml|yaml|editorconfig|gitattributes|gitignore)$/i;
const NAMED = new Set([
  "LICENSE", "LICENCE", "COPYING", "NOTICE", "AUTHORS", "CONTRIBUTORS",
  "CHANGELOG", "README", "Makefile", "Dockerfile", "CODEOWNERS",
]);

/*
 * Anything here is a value that belongs to one room. The list is deliberately
 * broader than the names that were actually present when it was written: the
 * point is to catch the NEXT one, added by somebody debugging against their
 * own machine.
 */
const IDENTITY = [
  [/joaqu/i, "a person's name"],
  /*
   * The GitHub account handle is exempt, and only the handle. It has to appear:
   * it is in the clone URL, in the issues URL and in the io.github namespace
   * that the official registry uses to prove who owns this package. What is
   * NOT allowed is the bare first name, which is what the origin project's
   * scenes were labelled with and which identifies a person rather than an
   * account.
   */
  [/giancarlo(?!26\b)/i, "a person's name (the account handle Giancarlo26 is allowed)"],
  [/\bdiego\b/i, "a person's name"],
  [/clanker/i, "a bot name from the origin project"],
  [/livwstream|livestream-studio/i, "the origin project's name"],
  [/startingatone|dylen/i, "a channel login"],
  [/\bbootcamp\b/i, "the origin project's narrative"],
  [/MIC-DJI|MIC-WAKE|PHONE-IRL|DET-[A-Z]|SCREEN-[A-Z]+|CAM-[A-Z]+/, "a source name from one collection"],
  [/\bthis rig\b/i, "first-person framing - say 'the reference machine'"],
];

const MACHINE = [
  [/[A-Za-z]:[\\/]{1,4}Users[\\/]/, "an absolute Windows home directory"],
  [/\/home\/[a-z0-9_-]+\//i, "an absolute Linux home directory"],
  [/\/Users\/[a-z0-9_-]+\//i, "an absolute macOS home directory"],
  [/100\.\d{1,3}\.\d{1,3}\.\d{1,3}/, "a Tailscale address"],
  [/\b\d+\.[a-z0-9-]+\.ts\.net\b/i, "a tailnet hostname"],
  [/192\.168\.\d{1,3}\.\d{1,3}/, "a LAN address"],
  [/\{0\.0\.[01]\.00000000\}\.\{[0-9a-f]{8}-/i, "a real Windows audio device GUID"],
];

const SECRETS = [
  [/AIzaSy[A-Za-z0-9_-]{25,}/, "a Google API key"],
  [/gh[pousr]_[A-Za-z0-9]{30,}/, "a GitHub token"],
  [/github_pat_[A-Za-z0-9_]{20,}/, "a GitHub fine-grained token"],
  [/GOCSPX-[A-Za-z0-9_-]{10,}/, "a Google OAuth secret"],
  [/rtmps?:\/\/[a-z0-9.-]+\/[a-z]+\/[A-Za-z0-9_-]{15,}/i, "a stream key"],
];

/*
 * Personal information, which is a separate question from project identity.
 * A repo can be entirely free of one project's scene names and still carry the
 * author's email in a comment, a real person's name in an example, or a
 * hostname that resolves to their house. These are checked on content only;
 * commit metadata is checked separately below, because git stores it outside
 * the files.
 */
const PERSONAL = [
  [/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i, "an email address"],
  [/\+\d{1,3}[\s.-]?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}/, "something shaped like a phone number"],
  [/\b(?:twitch\.tv|kick\.com|youtube\.com\/@|instagram\.com|x\.com|twitter\.com)\/[A-Za-z0-9_.-]+/i,
    "a personal social or channel URL"],
  [/\b(?:C:\\Users|\/Users\/|\/home\/)[A-Za-z0-9._-]+/i, "a home directory naming a user account"],
];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), out);
    } else if (TEXT.test(e.name) || e.name.startsWith(".") || NAMED.has(e.name)) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

const files = walk(ROOT);
let failed = 0;

function scan(label, rules) {
  const hits = [];
  for (const f of files) {
    const rel = path.relative(ROOT, f).replace(/\\/g, "/");
    let lines;
    try {
      lines = fs.readFileSync(f, "utf8").split("\n");
    } catch {
      continue;
    }
    lines.forEach((line, i) => {
      for (const [re, why] of rules) {
        const m = line.match(re);
        if (m) hits.push(`  ${rel}:${i + 1}  ${why}  ->  ${m[0].slice(0, 44)}`);
      }
    });
  }
  if (hits.length) {
    failed++;
    console.log(`\n  FAIL  ${label}`);
    console.log(hits.slice(0, 25).join("\n"));
    if (hits.length > 25) console.log(`  ... and ${hits.length - 25} more`);
  } else {
    console.log(`  ok    ${label}`);
  }
}

/*
 * Commit metadata. Git keeps the author name, the author email and any
 * Co-Authored-By trailers outside the working tree, so a repo whose FILES are
 * clean can still publish an address on every commit page. Checked here so
 * that fact is visible before a push rather than after.
 */
function scanGit() {
  const { execFileSync } = require("child_process");
  const run = (args) => {
    try {
      return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
    } catch {
      return null;
    }
  };
  if (run(["rev-parse", "--git-dir"]) === null) {
    console.log("  ok    no git history yet, nothing to leak in commit metadata");
    return;
  }
  const authors = [...new Set((run(["log", "--all", "--format=%an <%ae>"]) || "").split("\n").filter(Boolean))];
  const trailers = (run(["log", "--all", "--format=%(trailers:key=Co-Authored-By)"]) || "")
    .split("\n").map((s) => s.trim()).filter(Boolean);

  console.log(`  --    commit authors: ${authors.length ? authors.join(", ") : "none"}`);
  if (trailers.length) {
    failed++;
    console.log(`\n  FAIL  ${trailers.length} commit(s) carry a Co-Authored-By trailer`);
    console.log("        GitHub renders these as additional contributors.");
  } else {
    console.log("  ok    no Co-Authored-By trailers in history");
  }
}

console.log(`\n  preflight  ${files.length} files\n`);
scan("no credentials", SECRETS);
scan("no machine-specific values", MACHINE);
scan("no identity from the origin project", IDENTITY);
scan("no personal information", PERSONAL);
scanGit();

// Every module must load and every tool must be well formed.
try {
  const tools = require("../mcp/tools")({ request: async () => ({}) }, () => {});
  const bad = tools.filter(
    (t) => !t.name || !t.description || !t.inputSchema || typeof t.handler !== "function"
  );
  if (bad.length) {
    failed++;
    console.log(`\n  FAIL  tool shape: ${bad.length} malformed`);
  } else {
    console.log(`  ok    ${tools.length} module tools load and are well formed`);
  }
} catch (e) {
  failed++;
  console.log(`\n  FAIL  the tool registry did not load: ${e.message}`);
}

if (!fs.existsSync(path.join(ROOT, "LICENSE"))) {
  failed++;
  console.log("\n  FAIL  no LICENSE");
} else {
  console.log("  ok    LICENSE present");
}

console.log(failed ? `\n  ${failed} check(s) failed. Not ready to publish.\n`
                   : "\n  ready to publish\n");
process.exit(failed ? 1 : 0);
