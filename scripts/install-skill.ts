// Make the idj-triage Claude Code skill available in every project by linking it
// into ~/.claude/skills. A link (not a copy) so the token in .env.local and any
// edits to SKILL.md stay in this repo — the one source of truth.
//
//   bun run skill:install            # link (idempotent)
//   bun run skill:install --remove   # unlink
//
// Windows gets a directory junction (no admin / developer mode needed); everything
// else gets a symlink. Safe to re-run: an existing link pointing here is left alone,
// a real directory or a link pointing elsewhere is reported and NOT touched.

import { existsSync, lstatSync, readlinkSync, rmSync, symlinkSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL = "idj-triage";
const source = resolve(dirname(fileURLToPath(import.meta.url)), "..", ".claude", "skills", SKILL);
const skillsDir = join(homedir(), ".claude", "skills");
const target = join(skillsDir, SKILL);
const remove = process.argv.includes("--remove");

function isLink(p: string): boolean {
  try {
    const st = lstatSync(p);
    // Junctions report as symbolic links on Windows in Node >= 20.
    return st.isSymbolicLink();
  } catch {
    return false;
  }
}

function linkTarget(p: string): string | null {
  try {
    return resolve(readlinkSync(p));
  } catch {
    return null;
  }
}

if (!existsSync(join(source, "SKILL.md"))) {
  console.error(`skill source missing: ${source}`);
  process.exit(1);
}

if (remove) {
  if (!existsSync(target) && !isLink(target)) {
    console.log(`nothing to remove at ${target}`);
    process.exit(0);
  }
  if (!isLink(target)) {
    console.error(`${target} is a real directory, not a link — not removing it`);
    process.exit(1);
  }
  rmSync(target, { recursive: false, force: true });
  console.log(`unlinked ${target}`);
  process.exit(0);
}

mkdirSync(skillsDir, { recursive: true });

if (isLink(target)) {
  const current = linkTarget(target);
  if (current && resolve(current) === source) {
    console.log(`already linked: ${target} -> ${source}`);
  } else {
    console.error(`${target} is a link to ${current ?? "?"}, not to this repo — remove it first`);
    process.exit(1);
  }
} else if (existsSync(target)) {
  console.error(`${target} already exists as a real directory — move it aside first`);
  process.exit(1);
} else {
  // "junction" is honoured on Windows and ignored elsewhere (plain symlink).
  symlinkSync(source, target, "junction");
  console.log(`linked ${target} -> ${source}`);
}

if (!existsSync(join(source, ".env.local"))) {
  console.log(
    `\nno .env.local yet — copy .env.example to .env.local in ${source}\n` +
      `and paste an agent token:  bun run token:mint agent "claude-triage"`,
  );
}
