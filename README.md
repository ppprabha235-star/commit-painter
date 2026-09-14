# commit-painter 🟩

A Node.js script that backfills your GitHub contribution graph with backdated
commits — either as a randomized "I've been busy" fill, or as a deliberate
pixel-art / text pattern spelled out across the grid.

> **Heads up:** this fabricates history — it doesn't reflect real work. Don't
> use it to misrepresent your activity to employers, collaborators, etc.
> Treat it as graph art / a fun experiment, ideally on a throwaway or
> personal "art" repo rather than a repo anyone relies on for signal.

## How it works

GitHub's contribution graph is a grid: 7 rows (days, Sunday–Saturday) by
~52 columns (weeks), covering the last year. This script:

1. Computes a **plan** — a list of `{ date, count }` pairs describing which
   days should get commits and how many.
2. For each entry, writes a small change to `data/activity.json` and commits
   it with `git commit --date <that date>`, so the commit's authored date
   (what GitHub uses for the graph) lands on the day you want.
3. Optionally pushes everything to a remote at the end.

Two plan modes are supported (set in `config.json`):

- **`random`** — walks a date range day by day and randomly decides whether
  that day is "active," with a configurable number of commits (darker green
  = more commits that day).
- **`pattern`** — spells out a short piece of text using a built-in 5x7
  dot-matrix font, mapped onto the grid's columns/rows.

## Getting started

```bash
git clone <your-fork-url> commit-painter
cd commit-painter
npm install
```

Edit `config.json` to taste (see below), then:

```bash
npm start
```

This creates the commits locally. Review your `git log` — if it looks right,
push it yourself (`git push`), or set `"push": true` in the config to have
the script push automatically once it's done.

## Configuration (`config.json`)

```json
{
  "mode": "random",
  "startDate": null,
  "endDate": null,
  "random": {
    "activeDayProbability": 0.6,
    "minCommitsPerDay": 1,
    "maxCommitsPerDay": 4
  },
  "pattern": {
    "text": "HI",
    "startWeek": 0,
    "startDay": 0,
    "commitsPerCell": 3
  },
  "push": false,
  "remote": "origin",
  "branch": "main"
}
```

| Key | Meaning |
|---|---|
| `mode` | `"random"` or `"pattern"` |
| `startDate` / `endDate` | Optional ISO dates bounding `random` mode. Default: the last full year up to today. |
| `random.activeDayProbability` | 0–1 chance any given day gets commits |
| `random.minCommitsPerDay` / `maxCommitsPerDay` | Range of commits on an active day — controls shade of green |
| `pattern.text` | Text to draw (A-Z, 0-9, spaces supported) |
| `pattern.startWeek` / `startDay` | Column/row offset (0,0 = top-left of the grid, one year ago) so you can position the text |
| `pattern.commitsPerCell` | Commits per lit-up cell — higher = darker pixels |
| `push` | Auto-push when the script finishes |
| `remote` / `branch` | Used only if `push` is true |

## Cleanup & delete tool (`commit-tool.js`)

If you ever want to undo what the painter did — partially or completely —
use `commit-tool.js`. It's one file with several subcommands, so you don't
need to remember which of several scripts to reach for.

```bash
node commit-tool.js save-anchor
node commit-tool.js undo [--push] [--yes]
node commit-tool.js squash [--push] [--yes]
node commit-tool.js delete <commit-hash> [--push] [--yes]
node commit-tool.js delete --all [--push] [--yes]
node commit-tool.js delete-range --start YYYY-MM-DD --end YYYY-MM-DD [--push] [--yes]
node commit-tool.js delete-years 2023 2024 2025 [--push] [--yes]
node commit-tool.js delete-count 205 [--oldest|--newest|--random] [--push] [--yes]
node commit-tool.js clean-all <base-dir> 2023 2024 2025 [--push] [--yes]
```

Run `node commit-tool.js` with no arguments to see this list again.

### `save-anchor` / `undo` / `squash`

Run `save-anchor` once, before your first `npm start`, on a clean repo —
it records the current `HEAD` as a restore point.

- `undo` — deletes everything committed since the anchor (hard reset).
- `squash` — instead of deleting, collapses everything since the anchor
  into a single commit (keeps your current files, just drops the fake
  dated history).

Both refuse to run if you're on a different branch than the one the anchor
was saved on, and both ask for confirmation first.

### `delete <hash>` / `delete --all`

No anchor file needed — just point it at a commit hash directly.

```bash
git log --oneline                     # find the commit hash you want to keep
node commit-tool.js delete <hash> --push
```

Or wipe **all** history and start fresh (keeps your current files as one
new commit):
```bash
node commit-tool.js delete --all --push
```

### `delete-range` / `delete-years`

Remove commits only within a specific window, keeping everything before
and after it intact — this rewrites history via an automated interactive
rebase rather than a simple reset.

```bash
node commit-tool.js delete-range --start 2023-06-01 --end 2023-12-31 --push
node commit-tool.js delete-years 2023 2024 2025 --push
```

`delete-years` accepts multiple years at once in a single pass. Both print
how many commits will be removed vs. kept before asking for confirmation.

### `delete-count`

There's no such thing as a "negative commit count" in `config.json` —
`minCommitsPerDay`/`maxCommitsPerDay` only control how many *new* commits
get created; a negative value just makes the random count come out
negative, which the commit loop silently skips (0 created, nothing
deleted). If you actually want to remove a specific number of *existing*
commits, use this instead:

```bash
node commit-tool.js delete-count 205                # delete the 205 OLDEST commits
node commit-tool.js delete-count 205 --newest --push # delete the 205 NEWEST commits
node commit-tool.js delete-count 205 --random --push # delete 205 random ones
```

### `clean-all`

If you're not sure *which* repo has leftover fake activity, this scans
every git repo inside a folder (one level deep) and applies the year-based
cleanup to each one automatically — no manual `cd`-ing into each repo.

```bash
node commit-tool.js clean-all ~/projects 2023 2024 2025 --push
```

Repos with no matching commits are skipped untouched; non-repo folders are
ignored automatically.

### Shared behavior across all commands

- Every destructive command prints exactly what it's about to do and asks
  you to type `yes` first — pass `--yes` to skip that.
- `--push` force-pushes to `origin` after the local change — omit it to
  review locally first, then push yourself when ready.
- Same-file conflicts during a rebase (when a kept commit and a dropped
  commit both touch the same file) are auto-resolved by taking the kept
  commit's version — safe here since these scripts always fully overwrite
  the same file each commit.
- If deleting the very first commit in history would normally leave git's
  synthetic empty placeholder commit behind, the tool detects and removes
  it automatically so your real history stays clean.
- `delete-range`/`delete-years`/`clean-all` refuse to run if the deletion
  would wipe *every* commit in a repo (to avoid silently losing your
  current files) — use `delete --all` instead if a full wipe is really
  what you want.
- `anchor.json` is local bookkeeping only — it's already in `.gitignore`.

## Room for improvement

- Multi-line / multi-row patterns spanning more than one grid (e.g. across
  repos or years)
- A `--dry-run` flag that prints the planned commits without touching git
- Reading pattern text from a bitmap/image instead of the built-in font

## npm modules used

- [`moment`](https://www.npmjs.com/package/moment) — date math
- [`simple-git`](https://www.npmjs.com/package/simple-git) — scripted git commands
- [`random`](https://www.npmjs.com/package/random) — randomized day/commit counts
- [`jsonfile`](https://www.npmjs.com/package/jsonfile) — read/write the tiny payload file each commit touches
