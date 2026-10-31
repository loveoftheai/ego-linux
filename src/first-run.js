/**
 * first-run.js — Linux port of the ego lite app's launch-time and onboarding
 * setup for the entry Skill and the PATH registration.
 *
 * Contract (repo/docs/ego-browser-skill-command.md §2, original re-implementation):
 *   On every launch, check ~/.agents/skills/ego-browser:
 *     - Missing                                                  → copy agent-skills/ego-browser/ there as real files
 *     - A symlink the browser created earlier
 *       (to ~/.local/share/ego/ego-skills)                       → replace with a copy, then delete ~/.local/share/ego/ego-skills
 *     - Anything else (user / package-manager installed)         → leave untouched
 *   After the entry Skill is in place the launcher never writes
 *   ~/.agents/skills again; upgrades only replace the bundled payload.
 *
 * Onboarding equivalent (Linux has no GUI app): the original registers the
 * `ego-browser` command on the PATH during GUI onboarding, usually under
 * ~/.local/bin (skills/ego-browser/references/install.md). Here, the first
 * launch creates a ~/.local/bin/ego-browser symlink to this launcher so the
 * skill stays callable; it only ever creates a missing entry and never
 * touches an existing one, and it says so on stderr exactly once (when it
 * creates the link).
 *
 * Dependency-free (node:* only). Must never throw into the CLI: callers wrap
 * it in try/catch and continue on error.
 */
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

const HOME = homedir();
const SKILLS_DIR = join(HOME, ".agents", "skills");
const ENTRY_SKILL_DIR = join(SKILLS_DIR, "ego-browser");
const LEGACY_EGO_SKILLS = join(HOME, ".local", "share", "ego", "ego-skills");
const LOCAL_BIN = join(HOME, ".local", "bin");
const BIN_LINK = join(LOCAL_BIN, "ego-browser");
// Marker written inside an entry Skill that this launcher installed, so a
// later `ego-browser upgrade` can tell "ours, safe to refresh" apart from a
// user- or package-manager-installed skill (which is left untouched).
const MANAGED_MARKER = ".ego-linux-managed";
const MANAGED_MARKER_PAYLOAD = JSON.stringify({
  installedBy: "ego-browser-linux",
});

function isMissing(p) {
  try {
    lstatSync(p);
    return false;
  } catch (err) {
    if (err && err.code === "ENOENT") return true;
    throw err;
  }
}

function isSymlink(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Implements the §2 state table for the entry Skill.
 * @param {string} bundledEntrySkillDir - <bundled sdk>/agent-skills/ego-browser
 * @returns {"installed"|"migrated"|"untouched"|"source-missing"}
 */
export function ensureEntrySkill(bundledEntrySkillDir) {
  if (!existsSync(bundledEntrySkillDir)) return "source-missing";

  if (isMissing(ENTRY_SKILL_DIR)) {
    // Missing → copy as real files.
    mkdirSync(SKILLS_DIR, { recursive: true });
    cpSync(bundledEntrySkillDir, ENTRY_SKILL_DIR, { recursive: true });
    writeManagedMarker();
    return "installed";
  }

  if (isSymlink(ENTRY_SKILL_DIR)) {
    // Only the browser's own earlier symlink (to the legacy ego-skills dir)
    // gets replaced; a user-made symlink pointing elsewhere is left alone.
    const resolved = resolve(dirname(ENTRY_SKILL_DIR), readlinkSync(ENTRY_SKILL_DIR));
    if (resolved === LEGACY_EGO_SKILLS) {
      rmSync(ENTRY_SKILL_DIR, { force: true });
      cpSync(bundledEntrySkillDir, ENTRY_SKILL_DIR, { recursive: true });
      rmSync(LEGACY_EGO_SKILLS, { recursive: true, force: true });
      writeManagedMarker();
      return "migrated";
    }
    return "untouched";
  }

  // Real dir / file / anything else (user or package-manager installed).
  return "untouched";
}

/** Best-effort: tag an entry Skill this launcher installed. Never throws. */
function writeManagedMarker() {
  try {
    writeFileSync(join(ENTRY_SKILL_DIR, MANAGED_MARKER), MANAGED_MARKER_PAYLOAD + "\n");
  } catch {
    // Marker is advisory only; the install itself already succeeded.
  }
}

/**
 * Refresh the installed entry Skill after an `ego-browser upgrade` rebuilt
 * the bundled SDK. Only touches installs this launcher owns:
 *   - managed marker present → refresh unconditionally;
 *   - no marker, but the installed SKILL.md is byte-identical to the
 *     pre-upgrade bundled guide (pre-marker installs made by this launcher)
 *     → adopt and refresh;
 *   - anything else (user / package-manager installed, or user-modified) →
 *     left untouched.
 * @param {string} bundledEntrySkillDir - <new bundled sdk>/agent-skills/ego-browser
 * @param {string|null} oldGuidePath - pre-upgrade bundled SKILL.md, for adoption compare
 * @returns {"refreshed"|"adopted+refreshed"|"untouched"|"source-missing"}
 */
export function refreshManagedEntrySkill(bundledEntrySkillDir, oldGuidePath) {
  if (!existsSync(bundledEntrySkillDir)) return "source-missing";
  let owned = false;
  let adopted = false;
  try {
    const marker = readFileSync(join(ENTRY_SKILL_DIR, MANAGED_MARKER), "utf8");
    owned = marker.includes('"installedBy":"ego-browser-linux"');
  } catch {
    owned = false;
  }
  if (!owned && oldGuidePath) {
    try {
      const installedGuide = readFileSync(join(ENTRY_SKILL_DIR, "SKILL.md"));
      const oldGuide = readFileSync(oldGuidePath);
      if (installedGuide.equals(oldGuide)) {
        owned = true;
        adopted = true;
      }
    } catch {
      owned = false;
    }
  }
  if (!owned) return "untouched";
  rmSync(ENTRY_SKILL_DIR, { recursive: true, force: true });
  mkdirSync(SKILLS_DIR, { recursive: true });
  cpSync(bundledEntrySkillDir, ENTRY_SKILL_DIR, { recursive: true });
  writeManagedMarker();
  return adopted ? "adopted+refreshed" : "refreshed";
}

/**
 * Onboarding equivalent: make `ego-browser` resolvable on PATH.
 * Only creates ~/.local/bin/ego-browser when nothing is there; never
 * overwrites an existing entry. Returns a short status string.
 * @param {string} launcherPath - absolute path of this launcher
 */
export function ensurePathRegistration(launcherPath) {
  if (!isMissing(BIN_LINK)) return "untouched";
  mkdirSync(LOCAL_BIN, { recursive: true });
  symlinkSync(launcherPath, BIN_LINK);
  return "registered";
}

export function localBinOnPath() {
  const pathEnv = process.env.PATH || "";
  return pathEnv.split(":").includes(LOCAL_BIN);
}

/**
 * Run both first-run steps. Returns a summary; never throws.
 * Notices go to stderr exactly once per creation event, never to stdout
 * (so `ego-browser skill` output stays byte-identical to the guide).
 */
export function runFirstRun(bundledEntrySkillDir, launcherPath) {
  const summary = { entrySkill: "skipped", path: "skipped", notices: [] };
  try {
    summary.entrySkill = ensureEntrySkill(bundledEntrySkillDir);
  } catch (err) {
    summary.notices.push(`entry skill check failed: ${err && err.message}`);
  }
  try {
    summary.path = ensurePathRegistration(launcherPath);
    if (summary.path === "registered") {
      let note = `ego-browser: registered ${BIN_LINK} -> ${launcherPath}`;
      if (!localBinOnPath()) {
        note += ` (~/.local/bin is not on PATH; add: export PATH="$HOME/.local/bin:$PATH")`;
      }
      summary.notices.push(note);
    }
  } catch (err) {
    summary.notices.push(`PATH registration failed: ${err && err.message}`);
  }
  for (const n of summary.notices) process.stderr.write(`${n}\n`);
  return summary;
}
