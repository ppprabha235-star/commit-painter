// commit-tool.js
//
// One file, several subcommands, for undoing commit-painter's fake commits
// in different ways.
//
// USAGE:
//   node commit-tool.js save-anchor
//       Save current HEAD as a restore point (run once, before first `npm start`).
//
//   node commit-tool.js undo [--push] [--yes]
//       Reset back to the saved anchor, deleting everything since.
//
//   node commit-tool.js squash [--push] [--yes]
//       Collapse everything since the anchor into one commit (keeps files).
//
//   node commit-tool.js delete <commit-hash> [--push] [--yes]
//       Delete everything AFTER a specific commit.
//
//   node commit-tool.js delete --all [--push] [--yes]
//       Wipe ALL history, keep current files as one fresh commit.
//
//   node commit-tool.js delete-range --start YYYY-MM-DD --end YYYY-MM-DD [--push] [--yes]
//       Delete only commits in a date range, keep everything else.
//
//   node commit-tool.js delete-years 2023 2024 2025 [--push] [--yes]
//       Delete only commits in the given year(s), keep everything else.
//
//   node commit-tool.js delete-count 205 [--oldest|--newest|--random] [--push] [--yes]
//       Delete a specific NUMBER of existing commits.
//
//   node commit-tool.js clean-all <base-dir> 2023 2024 2025 [--push] [--yes]
//       Scan every git repo in a folder and delete matching years in each.
//
// Every destructive command prints what it's about to do and asks you to
// type 'yes' first (unless --yes is passed).

import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import readline from "readline";
import moment from "moment";
import simpleGit from "simple-git";

const EMPTY_TREE_HASH = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const ANCHOR_PATH = "./anchor.json";

// ---------- shared helpers ----------

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (ans) => {
      rl.close();
      resolve(ans.trim().toLowerCase());
    })
  );
}

async function confirm(message, skip) {
  if (skip) return true;
  const answer = await ask(`${message} Type 'yes' to continue: `);
  return answer === "yes";
}

function runGit(args, cwd) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

function runGitTrim(args, cwd) {
  return runGit(args, cwd).stdout.trim();
}

function shuffle(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function getAllCommitsOldestFirst(cwd) {
  const result = runGit(["log", "--reverse", "--pretty=format:%H"], cwd);
  if (result.status !== 0) return [];
  return result.stdout.trim().split("\n").filter(Boolean);
}

function getAllCommitsWithDates(cwd) {
  const result = runGit(["log", "--reverse", "--pretty=format:%H|%ad", "--date=iso-strict"], cwd);
  if (result.status !== 0) return [];
  return result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, date] = line.split("|");
      return { hash, date: moment(date) };
    });
}

// Drops the given set of commit hashes via an automated interactive rebase,
// auto-resolving same-file conflicts by taking the incoming commit's version,
// and cleaning up git's synthetic empty-root commit if the original first
// commit ends up dropped.
function dropCommits(hashes, { cwd = ".", branch } = {}) {
  const dropSetPath = path.join(cwd, ".commit-tool-dropset.json");
  const editorScriptPath = path.join(cwd, ".commit-tool-editor.cjs");
  fs.writeFileSync(dropSetPath, JSON.stringify(hashes));
  fs.writeFileSync(
    editorScriptPath,
    `const fs = require("fs");
const todoFile = process.argv[2];
const dropSet = JSON.parse(fs.readFileSync(${JSON.stringify(dropSetPath)}, "utf8"));
const lines = fs.readFileSync(todoFile, "utf8").split("\\n");
const updated = lines.map((line) => {
  const m = line.match(/^pick (\\S+)/);
  if (m) {
    const shortHash = m[1];
    const matches = dropSet.some((full) => full.startsWith(shortHash) || shortHash.startsWith(full));
    if (matches) return line.replace(/^pick/, "drop");
  }
  return line;
});
fs.writeFileSync(todoFile, updated.join("\\n"));
`
  );

  let result = spawnSync("git", ["rebase", "-i", "--root"], {
    cwd,
    stdio: "inherit",
    env: { ...process.env, GIT_SEQUENCE_EDITOR: `node "${editorScriptPath}"`, GIT_EDITOR: "true" },
  });

  while (result.status !== 0) {
    const inProgress =
      fs.existsSync(path.join(cwd, ".git/rebase-merge")) ||
      fs.existsSync(path.join(cwd, ".git/rebase-apply"));
    if (!inProgress) break;

    const conflicted = runGitTrim(["diff", "--name-only", "--diff-filter=U"], cwd)
      .split("\n")
      .filter(Boolean);
    if (conflicted.length === 0) break;

    for (const file of conflicted) {
      const theirs = runGit(["checkout", "--theirs", "--", file], cwd);
      if (theirs.status === 0) runGit(["add", "--", file], cwd);
      else runGit(["rm", "-f", "--", file], cwd);
    }
    result = spawnSync("git", ["rebase", "--continue"], {
      cwd,
      stdio: "inherit",
      env: { ...process.env, GIT_EDITOR: "true" },
    });
  }

  fs.rmSync(dropSetPath, { force: true });
  fs.rmSync(editorScriptPath, { force: true });

  if (result.status === 0 && branch) stripSyntheticEmptyRootIfPresent(cwd, branch);
  return result;
}

function stripSyntheticEmptyRootIfPresent(cwd, branch) {
  const rootHash = runGitTrim(["rev-list", "--max-parents=0", "HEAD"], cwd);
  if (!rootHash || rootHash.includes("\n")) return;
  const treeHash = runGitTrim(["rev-parse", `${rootHash}^{tree}`], cwd);
  if (treeHash !== EMPTY_TREE_HASH) return;

  console.log("Cleaning up an empty placeholder commit git inserted internally...");
  const allHashes = runGitTrim(["log", "--reverse", "--format=%H"], cwd).split("\n").filter(Boolean);
  const rest = allHashes.slice(1);

  let parent = null;
  for (const hash of rest) {
    const tree = runGitTrim(["rev-parse", `${hash}^{tree}`], cwd);
    const an = runGitTrim(["log", "-1", "--format=%an", hash], cwd);
    const ae = runGitTrim(["log", "-1", "--format=%ae", hash], cwd);
    const ad = runGitTrim(["log", "-1", "--format=%ad", "--date=iso-strict", hash], cwd);
    const cn = runGitTrim(["log", "-1", "--format=%cn", hash], cwd);
    const ce = runGitTrim(["log", "-1", "--format=%ce", hash], cwd);
    const cd = runGitTrim(["log", "-1", "--format=%cd", "--date=iso-strict", hash], cwd);
    const msg = runGit(["log", "-1", "--format=%B", hash], cwd).stdout;

    const args = ["commit-tree", tree];
    if (parent) args.push("-p", parent);
    args.push("-m", msg.replace(/\n+$/, ""));
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: an,
      GIT_AUTHOR_EMAIL: ae,
      GIT_AUTHOR_DATE: ad,
      GIT_COMMITTER_NAME: cn,
      GIT_COMMITTER_EMAIL: ce,
      GIT_COMMITTER_DATE: cd,
    };
    parent = spawnSync("git", args, { cwd, encoding: "utf8", env }).stdout.trim();
  }

  runGit(["update-ref", `refs/heads/${branch}`, parent], cwd);
  runGit(["checkout", branch], cwd);
  runGit(["reset", "--hard", parent], cwd);
}

async function pushIfRequested(push, branch, cwd = ".") {
  if (!push) {
    console.log(`Run "git push --force origin ${branch}" when ready.`);
    return;
  }
  console.log("Force-pushing...");
  const result = runGit(["push", "--force", "origin", branch], cwd);
  if (result.status === 0) {
    console.log("Pushed. GitHub's contribution graph may take a few minutes to update.");
  } else {
    console.error(`Push failed:\n${result.stderr}`);
  }
}

async function requireRepo() {
  const git = simpleGit();
  if (!(await git.checkIsRepo())) {
    console.error("Not a git repository.");
    process.exit(1);
  }
  const branch = (await git.branchLocal()).current;
  return branch;
}

// ---------- subcommands ----------

async function cmdSaveAnchor() {
  const branch = await requireRepo();
  const hash = runGitTrim(["rev-parse", "HEAD"]);
  fs.writeFileSync(
    ANCHOR_PATH,
    JSON.stringify({ hash, branch, savedAt: new Date().toISOString() }, null, 2)
  );
  console.log(`Anchor saved: ${hash} (branch "${branch}").`);
  console.log("Commits made after this point can be removed with: node commit-tool.js undo");
}

function readAnchor() {
  if (!fs.existsSync(ANCHOR_PATH)) return null;
  return JSON.parse(fs.readFileSync(ANCHOR_PATH, "utf8"));
}

async function cmdUndo({ push, yes }) {
  const anchor = readAnchor();
  if (!anchor) {
    console.error("No anchor found. Run: node commit-tool.js save-anchor");
    process.exit(1);
  }
  const branch = await requireRepo();
  if (branch !== anchor.branch) {
    console.error(`On branch "${branch}", but anchor was saved on "${anchor.branch}". Switch branches first.`);
    process.exit(1);
  }

  const commits = getAllCommitsOldestFirst();
  const anchorIdx = commits.indexOf(anchor.hash);
  const toDrop = anchorIdx === -1 ? commits : commits.slice(anchorIdx + 1);

  if (toDrop.length === 0) {
    console.log("Nothing to undo — HEAD is already at the anchor.");
    return;
  }

  console.log(`This will delete ${toDrop.length} commit(s) made after the anchor (${anchor.hash}).`);
  if (push) console.log(`Then force-push branch "${branch}".`);
  const ok = await confirm("This cannot be undone locally.", yes);
  if (!ok) return console.log("Aborted — nothing was changed.");

  await simpleGit().reset(["--hard", anchor.hash]);
  console.log(`Done. HEAD is now at ${anchor.hash}.`);
  await pushIfRequested(push, branch);
}

async function cmdSquash({ push, yes }) {
  const anchor = readAnchor();
  if (!anchor) {
    console.error("No anchor found. Run: node commit-tool.js save-anchor");
    process.exit(1);
  }
  const branch = await requireRepo();

  const commits = getAllCommitsOldestFirst();
  const anchorIdx = commits.indexOf(anchor.hash);
  const toSquash = anchorIdx === -1 ? commits : commits.slice(anchorIdx + 1);

  if (toSquash.length === 0) {
    console.log("Nothing to squash — HEAD is already at the anchor.");
    return;
  }

  console.log(`This will squash ${toSquash.length} commit(s) since the anchor into one commit.`);
  const ok = await confirm("Continue?", yes);
  if (!ok) return console.log("Aborted — nothing was changed.");

  await simpleGit().reset(["--soft", anchor.hash]);
  await simpleGit().commit("chore: squash generated activity into one commit");
  console.log("Squash complete.");
  await pushIfRequested(push, branch);
}

async function cmdDelete(args, { push, yes }) {
  const branch = await requireRepo();
  const allCommits = getAllCommitsOldestFirst();

  if (args.includes("--all")) {
    console.log(`This will DELETE ALL ${allCommits.length} commit(s) of history on branch "${branch}".`);
    console.log("Your current files are kept, as a single new commit.");
    const ok = await confirm("This cannot be undone locally.", yes);
    if (!ok) return console.log("Aborted — nothing was changed.");

    const tempBranch = `wiped-${Date.now()}`;
    runGit(["checkout", "--orphan", tempBranch]);
    runGit(["rm", "-rf", "--cached", "."]);
    runGit(["add", "-A"]);
    runGit(["commit", "-m", "Initial commit"]);
    runGit(["branch", "-D", branch]);
    runGit(["branch", "-m", branch]);
    console.log(`Done. Branch "${branch}" now has a single commit and no prior history.`);
    await pushIfRequested(push, branch);
    return;
  }

  const hash = args.find((a) => !a.startsWith("--"));
  if (!hash) {
    console.error("Usage: node commit-tool.js delete <commit-hash> [--push] [--yes]");
    process.exit(1);
  }
  if (runGit(["rev-parse", hash]).status !== 0) {
    console.error(`Commit "${hash}" not found.`);
    process.exit(1);
  }

  const idx = allCommits.indexOf(runGitTrim(["rev-parse", hash]));
  const willDelete = idx === -1 ? 0 : allCommits.length - idx - 1;
  if (willDelete === 0) {
    console.log("Nothing to delete — HEAD is already at that commit.");
    return;
  }

  console.log(`This will delete ${willDelete} commit(s) after ${hash} on branch "${branch}".`);
  const ok = await confirm("This cannot be undone locally.", yes);
  if (!ok) return console.log("Aborted — nothing was changed.");

  await simpleGit().reset(["--hard", hash]);
  console.log(`Done. HEAD is now at ${hash}.`);
  await pushIfRequested(push, branch);
}

async function cmdDeleteRange(args, { push, yes }) {
  const startArg = args[args.indexOf("--start") + 1];
  const endArg = args[args.indexOf("--end") + 1];
  if (!startArg || !endArg) {
    console.error("Usage: node commit-tool.js delete-range --start YYYY-MM-DD --end YYYY-MM-DD [--push] [--yes]");
    process.exit(1);
  }
  const start = moment(startArg).startOf("day");
  const end = moment(endArg).endOf("day");

  const branch = await requireRepo();
  const commits = getAllCommitsWithDates();
  const toDrop = commits.filter((c) => c.date.isBetween(start, end, undefined, "[]"));

  if (toDrop.length === 0) {
    console.log(`No commits found between ${start.format("YYYY-MM-DD")} and ${end.format("YYYY-MM-DD")}.`);
    return;
  }

  if (toDrop.length === commits.length) {
    console.error(
      `Every commit in this repo falls in that range — this would wipe all history and lose your current files. Use "delete --all" instead, which safely keeps your current files as a fresh commit.`
    );
    process.exit(1);
  }

  console.log(`This will delete ${toDrop.length} commit(s) between ${start.format("YYYY-MM-DD")} and ${end.format("YYYY-MM-DD")}.`);
  console.log(`${commits.length - toDrop.length} commit(s) outside that range will be kept.`);
  const ok = await confirm("This rewrites history and cannot be undone locally.", yes);
  if (!ok) return console.log("Aborted — nothing was changed.");

  console.log("Running rebase...");
  const result = dropCommits(toDrop.map((c) => c.hash), { branch });
  if (result.status !== 0) {
    console.error("Rebase stopped on a conflict it couldn't auto-resolve.");
    console.error("Run 'git rebase --continue' or 'git rebase --abort'.");
    process.exit(1);
  }
  console.log(`Done. ${toDrop.length} commit(s) removed, the rest kept.`);
  await pushIfRequested(push, branch);
}

async function cmdDeleteYears(args, { push, yes }) {
  const years = args.filter((a) => /^\d{4}$/.test(a)).map(Number);
  if (years.length === 0) {
    console.error("Usage: node commit-tool.js delete-years 2023 2024 2025 [--push] [--yes]");
    process.exit(1);
  }

  const branch = await requireRepo();
  const commits = getAllCommitsWithDates();
  const toDrop = commits.filter((c) => years.includes(c.date.year()));

  if (toDrop.length === 0) {
    console.log(`No commits found in ${years.join(", ")}.`);
    return;
  }

  if (toDrop.length === commits.length) {
    console.error(
      `Every commit in this repo falls in ${years.join(", ")} — this would wipe all history and lose your current files. Use "delete --all" instead, which safely keeps your current files as a fresh commit.`
    );
    process.exit(1);
  }

  console.log(`This will delete ${toDrop.length} commit(s) dated in ${years.join(", ")}.`);
  console.log(`${commits.length - toDrop.length} commit(s) in other years will be kept.`);
  const ok = await confirm("This rewrites history and cannot be undone locally.", yes);
  if (!ok) return console.log("Aborted — nothing was changed.");

  console.log("Running rebase...");
  const result = dropCommits(toDrop.map((c) => c.hash), { branch });
  if (result.status !== 0) {
    console.error("Rebase stopped on a conflict it couldn't auto-resolve.");
    console.error("Run 'git rebase --continue' or 'git rebase --abort'.");
    process.exit(1);
  }
  console.log(`Done. ${toDrop.length} commit(s) removed, the rest kept.`);
  await pushIfRequested(push, branch);
}

async function cmdDeleteCount(args, { push, yes }) {
  const mode = args.includes("--newest") ? "newest" : args.includes("--random") ? "random" : "oldest";
  const countArg = args.find((a) => /^\d+$/.test(a));
  const count = countArg ? parseInt(countArg, 10) : null;
  if (!count || count <= 0) {
    console.error("Usage: node commit-tool.js delete-count <number> [--oldest|--newest|--random] [--push] [--yes]");
    process.exit(1);
  }

  const branch = await requireRepo();
  const allCommits = getAllCommitsOldestFirst();
  if (count >= allCommits.length) {
    console.error(`Only ${allCommits.length} commit(s) exist. Use "delete --all" instead if you want everything gone.`);
    process.exit(1);
  }

  let toDrop;
  if (mode === "oldest") toDrop = allCommits.slice(0, count);
  else if (mode === "newest") toDrop = allCommits.slice(-count);
  else toDrop = shuffle(allCommits).slice(0, count);

  console.log(`This will delete ${count} commit(s) (${mode}) out of ${allCommits.length} total.`);
  console.log(`${allCommits.length - count} commit(s) will be kept.`);
  const ok = await confirm("This rewrites history and cannot be undone locally.", yes);
  if (!ok) return console.log("Aborted — nothing was changed.");

  console.log("Running rebase...");
  const result = dropCommits(toDrop, { branch });
  if (result.status !== 0) {
    console.error("Rebase stopped on a conflict it couldn't auto-resolve.");
    console.error("Run 'git rebase --continue' or 'git rebase --abort'.");
    process.exit(1);
  }
  console.log(`Done. ${count} commit(s) removed, ${allCommits.length - count} kept.`);
  await pushIfRequested(push, branch);
}

async function cmdCleanAll(args, { push, yes }) {
  const baseDir = args.find((a) => !a.startsWith("--") && !/^\d{4}$/.test(a));
  const years = args.filter((a) => /^\d{4}$/.test(a)).map(Number);
  if (!baseDir || years.length === 0) {
    console.error("Usage: node commit-tool.js clean-all <base-dir> 2023 2024 2025 [--push] [--yes]");
    process.exit(1);
  }

  const resolvedBase = path.resolve(baseDir);
  if (!fs.existsSync(resolvedBase)) {
    console.error(`Base directory not found: ${baseDir}`);
    process.exit(1);
  }

  const repos = fs
    .readdirSync(resolvedBase, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(resolvedBase, e.name))
    .filter((dir) => fs.existsSync(path.join(dir, ".git")));

  if (repos.length === 0) {
    console.log(`No git repositories found directly inside ${baseDir}.`);
    return;
  }

  console.log(`Found ${repos.length} repo(s): ${repos.map((r) => path.basename(r)).join(", ")}`);
  console.log(`Checking each for commits dated in ${years.join(", ")}...`);

  for (const repoDir of repos) {
    const repoName = path.basename(repoDir);
    console.log(`\n=== ${repoName} ===`);

    const branch = runGitTrim(["rev-parse", "--abbrev-ref", "HEAD"], repoDir);
    const commits = getAllCommitsWithDates(repoDir);
    const toDrop = commits.filter((c) => years.includes(c.date.year()));

    if (toDrop.length === 0) {
      console.log(`  No commits found in ${years.join(", ")} — skipping.`);
      continue;
    }

    if (toDrop.length === commits.length) {
      console.log(
        `  Every commit in ${repoName} falls in ${years.join(", ")} — skipping to avoid wiping it silently. Run "node commit-tool.js delete --all" inside it directly if that's really what you want.`
      );
      continue;
    }

    console.log(`  ${toDrop.length} commit(s) will be deleted, ${commits.length - toDrop.length} kept.`);
    const ok = await confirm(`  Proceed with ${repoName}?`, yes);
    if (!ok) {
      console.log("  Skipped.");
      continue;
    }

    const result = dropCommits(toDrop.map((c) => c.hash), { cwd: repoDir, branch });
    if (result.status !== 0) {
      console.error(`  Rebase stopped on a conflict it couldn't auto-resolve in ${repoName}.`);
      console.error(`  Resolve manually inside ${repoDir}.`);
      continue;
    }
    console.log(`  Done — ${toDrop.length} commit(s) removed.`);
    await pushIfRequested(push, branch, repoDir);
  }

  console.log("\nAll repos checked.");
}

// ---------- dispatch ----------

async function main() {
  const [, , command, ...rest] = process.argv;
  const push = rest.includes("--push");
  const yes = rest.includes("--yes");

  switch (command) {
    case "save-anchor":
      return cmdSaveAnchor();
    case "undo":
      return cmdUndo({ push, yes });
    case "squash":
      return cmdSquash({ push, yes });
    case "delete":
      return cmdDelete(rest, { push, yes });
    case "delete-range":
      return cmdDeleteRange(rest, { push, yes });
    case "delete-years":
      return cmdDeleteYears(rest, { push, yes });
    case "delete-count":
      return cmdDeleteCount(rest, { push, yes });
    case "clean-all":
      return cmdCleanAll(rest, { push, yes });
    default:
      console.error(`Unknown or missing command: "${command || ""}"\n`);
      console.error(
        [
          "Available commands:",
          "  save-anchor",
          "  undo [--push] [--yes]",
          "  squash [--push] [--yes]",
          "  delete <hash>|--all [--push] [--yes]",
          "  delete-range --start YYYY-MM-DD --end YYYY-MM-DD [--push] [--yes]",
          "  delete-years <year...> [--push] [--yes]",
          "  delete-count <n> [--oldest|--newest|--random] [--push] [--yes]",
          "  clean-all <base-dir> <year...> [--push] [--yes]",
        ].join("\n")
      );
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("commit-tool.js failed:", err);
  process.exit(1);
});
