// install-hooks.mjs — proves bin/mnemosyne-install-hooks merges
// hooks/settings.hooks.json into a Claude Code settings.json correctly:
// path rewriting, no-duplicate merge, unreachable-service warning, and
// idempotent re-run behavior. Uses a temp settings.json — never touches
// the real ~/.claude/settings.json.
//
//   node test/install-hooks.mjs

import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  REPO_ROOT,
  absolutizeCommand,
  mergeHooks,
  readSettings,
  writeSettingsAtomic,
  run,
} from "../bin/mnemosyne-install-hooks";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let fails = 0;
const ok = (c, m) => { console.log(`${c ? "  PASS" : "  FAIL"}  ${m}`); if (!c) fails++; };

const workdir = mkdtempSync(path.join(tmpdir(), "mnemosyne-install-hooks-"));
const settingsPath = path.join(workdir, "settings.json");
// deliberately unreachable — proves the installer warns instead of hanging
const UNREACHABLE_URL = "http://127.0.0.1:1";

// --- absolutizeCommand: relative and stale-absolute paths both normalize ----
ok(
  absolutizeCommand("node ./hooks/pre-recall.mjs", REPO_ROOT) ===
    `node ${path.join(REPO_ROOT, "hooks/pre-recall.mjs")}`,
  "absolutizeCommand rewrites a relative ./hooks/x.mjs path"
);
ok(
  absolutizeCommand("node /some/other/machine/hooks/post-remember.mjs", REPO_ROOT) ===
    `node ${path.join(REPO_ROOT, "hooks/post-remember.mjs")}`,
  "absolutizeCommand rewrites a stale absolute path from another checkout"
);

// --- mergeHooks: fresh merge adds, re-merge updates without duplicating ----
const template = {
  hooks: {
    UserPromptSubmit: [{ hooks: [{ type: "command", command: "node /old/hooks/pre-recall.mjs" }] }],
  },
};
const first = mergeHooks(undefined, template);
ok(first.added.length === 1 && first.updated.length === 0, "mergeHooks adds a new hook on first merge");
ok(first.merged.UserPromptSubmit.length === 1, "mergeHooks produces exactly one group for the event");

const movedTemplate = {
  hooks: {
    UserPromptSubmit: [{ hooks: [{ type: "command", command: "node /new/hooks/pre-recall.mjs" }] }],
  },
};
const second = mergeHooks(first.merged, movedTemplate);
ok(second.added.length === 0 && second.updated.length === 1, "mergeHooks updates in place, does not duplicate");
ok(second.merged.UserPromptSubmit.length === 1, "no duplicate group after re-merge");
ok(
  second.merged.UserPromptSubmit[0].hooks[0].command === "node /new/hooks/pre-recall.mjs",
  "mergeHooks rewrote the existing entry's command to the new path"
);

const unrelated = {
  UserPromptSubmit: [{ hooks: [{ type: "command", command: "node /other-tool/hook.mjs" }] }],
};
const withUnrelated = mergeHooks(unrelated, template);
ok(
  withUnrelated.merged.UserPromptSubmit.length === 2 &&
    withUnrelated.merged.UserPromptSubmit.some((g) => g.hooks[0].command === "node /other-tool/hook.mjs"),
  "mergeHooks leaves unrelated existing hook entries untouched"
);

// --- writeSettingsAtomic / readSettings round-trip + backup -----------------
writeSettingsAtomic(settingsPath, { hooks: { UserPromptSubmit: [] } });
ok(readSettings(settingsPath).hooks.UserPromptSubmit.length === 0, "writeSettingsAtomic + readSettings round-trip");
writeSettingsAtomic(settingsPath, { hooks: { UserPromptSubmit: [], Stop: [] } });
ok(
  JSON.parse(readFileSync(`${settingsPath}.bak`, "utf8")).hooks.Stop === undefined,
  "writeSettingsAtomic backs up the previous settings.json before overwriting"
);

// --- readSettings on missing / empty settings.json --------------------------
ok(Object.keys(readSettings(path.join(workdir, "nope.json"))).length === 0, "readSettings returns {} for a missing file");

// --- end-to-end run(): unreachable service + --yes still installs -----------
rmSync(settingsPath, { force: true });
rmSync(`${settingsPath}.bak`, { force: true });
const logs = [];
const warns = [];
const runResult = await run({
  settingsPath,
  serviceUrl: UNREACHABLE_URL,
  yes: true,
  log: (m) => logs.push(m),
  warn: (m) => warns.push(m),
});
ok(runResult.installed === true, "run() installs even when the service is unreachable, given --yes");
ok(warns.some((w) => /unreachable/i.test(w)), "run() warns when the Mnemosyne service is unreachable");

const installedSettings = readSettings(settingsPath);
const preRecallCommand = installedSettings.hooks.UserPromptSubmit[0].hooks[0].command;
ok(
  preRecallCommand === `node ${path.join(REPO_ROOT, "hooks", "pre-recall.mjs")}`,
  `run() writes an absolute pre-recall.mjs path for THIS repo (got: ${preRecallCommand})`
);
ok(
  installedSettings.hooks.Stop[0].hooks[0].command.includes(REPO_ROOT),
  "run() writes an absolute Stop -> post-remember.mjs path"
);

// --- end-to-end run(): unreachable service, no --yes, non-interactive -> abort
rmSync(settingsPath, { force: true });
const abortLogs = [];
const abortResult = await run({
  settingsPath,
  serviceUrl: UNREACHABLE_URL,
  yes: false,
  log: (m) => abortLogs.push(m),
  warn: () => {},
});
ok(abortResult.installed === false, "run() aborts on an unreachable service with no --yes and no TTY to prompt");
ok(abortLogs.some((l) => /abort/i.test(l)), "run() explains the abort");

// --- idempotent re-run: second run against the same settings.json updates,
// does not duplicate, and reports the required confirmation message ---------
const idemLogs1 = [];
await run({ settingsPath, serviceUrl: UNREACHABLE_URL, yes: true, log: (m) => idemLogs1.push(m), warn: () => {} });
const afterFirst = readSettings(settingsPath);
const groupCountAfterFirst = afterFirst.hooks.UserPromptSubmit.length;

const idemLogs2 = [];
const rerun = await run({ settingsPath, serviceUrl: UNREACHABLE_URL, yes: true, log: (m) => idemLogs2.push(m), warn: () => {} });
const afterSecond = readSettings(settingsPath);

ok(rerun.installed === true, "idempotent re-run installs successfully");
ok(
  afterSecond.hooks.UserPromptSubmit.length === groupCountAfterFirst,
  "idempotent re-run does not duplicate hook entries"
);
ok(
  idemLogs2.some((l) => l.includes("hooks already installed, paths updated")),
  `idempotent re-run confirms "hooks already installed, paths updated" (got: ${JSON.stringify(idemLogs2)})`
);

rmSync(workdir, { recursive: true, force: true });

console.log(fails ? `\n${fails} check(s) failed` : "\nall install-hooks checks passed");
process.exit(fails ? 1 : 0);
