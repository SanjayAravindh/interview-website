#!/usr/bin/env node
/**
 * Stage note files, commit, push main, and publish GitHub Pages.
 *
 * Usage (from repo root):
 *   npm run publish-site
 *   node scripts/publish-site.js
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const COMMIT_MESSAGE = "Add Java and Spring interview notes.";
const NOTE_PATHS = ["notes/Java", "notes/Spring"];

process.chdir(ROOT);

function log(cmd, args) {
  console.log(`$ ${[cmd, ...args].join(" ")}`);
}

function run(cmd, args, options = {}) {
  log(cmd, args);
  const result = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    shell: false,
  });
  if (result.status !== 0) {
    const err = (result.stderr || result.stdout || "").trim();
    if (!options.allowFail) {
      if (options.capture && err) console.error(err);
      process.exit(result.status ?? 1);
    }
  }
  return result;
}

function output(cmd, args) {
  const result = run(cmd, args, { capture: true, allowFail: true });
  if (result.status !== 0) {
    const err = (result.stderr || result.stdout || "").trim();
    throw new Error(err || `${cmd} ${args.join(" ")} failed`);
  }
  return (result.stdout || "").trim();
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const toAdd = NOTE_PATHS.filter((p) => fs.existsSync(path.join(ROOT, p)));
if (toAdd.length === 0) {
  console.error("No notes directories found (looked for notes/Java and notes/Spring).");
  process.exit(1);
}

function latestRun() {
  const json = output("gh", [
    "run",
    "list",
    "--workflow",
    "pages.yml",
    "--limit",
    "1",
    "--json",
    "databaseId,status,url,displayTitle",
  ]);
  const rows = JSON.parse(json || "[]");
  return rows[0] || null;
}

function pagesUrl() {
  return output("gh", ["api", "repos/{owner}/{repo}/pages", "--jq", ".html_url"]);
}

console.log(`Staging: ${toAdd.join(", ")}`);
run("git", ["add", "--", ...toAdd]);

const porcelain = output("git", ["status", "--porcelain", "--", ...toAdd]);
let committed = false;
if (porcelain) {
  run("git", ["commit", "-m", COMMIT_MESSAGE]);
  committed = true;
} else {
  console.log("No new note files to commit.");
}

const previousId = (latestRun() || {}).databaseId || null;

run("git", ["push", "origin", "main"]);

console.log("Triggering GitHub Pages workflow...");
const trigger = run("gh", ["workflow", "run", "pages.yml", "--ref", "main"], {
  allowFail: true,
});
if (trigger.status !== 0) {
  console.log(
    "Could not dispatch pages.yml (gh may be read-only). Push to main is the deploy trigger."
  );
}

const started = Date.now();
let runInfo = null;
if (trigger.status === 0 || committed) {
  while (Date.now() - started < 45000) {
    sleep(2000);
    runInfo = latestRun();
    if (runInfo && runInfo.databaseId !== previousId) break;
  }
}

if (!runInfo || runInfo.databaseId === previousId) {
  const url = pagesUrl();
  if (committed) {
    console.error(`Pushed notes, but no Pages run appeared yet. Site: ${url}`);
    process.exit(1);
  }
  console.log(`No new Pages run (nothing new to publish). Site: ${url}`);
  process.exit(0);
}

console.log(`Watching ${runInfo.displayTitle}: ${runInfo.url}`);
run("gh", ["run", "watch", String(runInfo.databaseId), "--exit-status"]);
console.log(`Published: ${pagesUrl()}`);
