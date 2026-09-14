import fs from "fs";
import jsonfile from "jsonfile";
import moment from "moment";
import simpleGit from "simple-git";
import random from "random";
import { textToCells } from "./font.js";

const CONFIG_PATH = "./config.json";
const DATA_PATH = "./data/activity.json";

async function loadConfig() {
  const config = await jsonfile.readFile(CONFIG_PATH);
  return config;
}

// Sunday of the week that started exactly one year ago — this is column 0,
// row 0 of the contribution grid GitHub will render.
function gridOrigin() {
  return moment().subtract(1, "year").startOf("week");
}

function buildRandomPlan(config) {
  const start = config.startDate ? moment(config.startDate) : gridOrigin();
  const end = config.endDate ? moment(config.endDate) : moment();
  const { activeDayProbability, minCommitsPerDay, maxCommitsPerDay } = config.random;

  const plan = [];
  const cursor = start.clone();
  while (cursor.isSameOrBefore(end, "day")) {
    if (random.float(0, 1) < activeDayProbability) {
      const count = random.int(minCommitsPerDay, maxCommitsPerDay);
      plan.push({ date: cursor.clone(), count });
    }
    cursor.add(1, "day");
  }
  return plan;
}

function buildPatternPlan(config) {
  const origin = gridOrigin();
  const { text, startWeek, startDay, commitsPerCell } = config.pattern;
  const { cells } = textToCells(text);

  return cells.map(({ col, row }) => ({
    date: origin
      .clone()
      .add(startWeek + col, "weeks")
      .add(startDay + row, "days"),
    count: commitsPerCell,
  }));
}

async function ensureRepo() {
  const git = simpleGit();
  const isRepo = await git.checkIsRepo();
  if (!isRepo) {
    console.log("No git repo here yet — running `git init`.");
    await git.init();
  }
  fs.mkdirSync("./data", { recursive: true });
  return git;
}

async function commitOnce(git, date, seq) {
  const timestamp = date.clone().add(seq, "seconds").format(); // keeps same-day commits ordered
  await jsonfile.writeFile(DATA_PATH, { date: timestamp, seq });
  await git.add([DATA_PATH]);
  await git.commit(`chore: activity log — ${timestamp}`, { "--date": timestamp });
}

async function runPlan(git, plan) {
  let total = 0;
  let seq = 0;
  for (const { date, count } of plan) {
    for (let i = 0; i < count; i++) {
      await commitOnce(git, date, seq);
      seq++;
      total++;
    }
  }
  return total;
}

async function main() {
  const config = await loadConfig();
  const git = await ensureRepo();

  const plan =
    config.mode === "pattern" ? buildPatternPlan(config) : buildRandomPlan(config);

  console.log(
    `Mode: ${config.mode} — ${plan.length} active day(s), ${plan.reduce(
      (sum, p) => sum + p.count,
      0
    )} total commit(s) planned.`
  );

  const total = await runPlan(git, plan);
  console.log(`Done — created ${total} commit(s).`);

  if (config.push) {
    console.log(`Pushing to ${config.remote}/${config.branch}...`);
    await git.push(config.remote, config.branch);
    console.log("Pushed.");
  } else {
    console.log("push=false in config.json — commits were made locally only.");
  }
}

main().catch((err) => {
  console.error("goGreen failed:", err);
  process.exit(1);
});
