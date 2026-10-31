// Linux profile import for ego-browser.
//
// The original `ego-browser import --browser <browser>` copies the user's
// real browser profile data (cookies, logins, storage) into the app's own
// profile store, so task spaces created with that profileId carry real
// login state. This module implements the Linux equivalent: it copies a
// Chrome/Chromium/Brave profile directory into the ego profile store
// (~/.local/share/ego-lite-linux/profiles/<browser>-<dir>/), which the
// binding layer then serves through a dedicated Chromium instance
// (see src/chromium.js ensureChromium({ profileId })).

import { existsSync } from "node:fs";
import { cp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { PROFILES_DIR } from "./chromium.js";

function configHome() {
  return process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
}

export const SOURCE_BROWSERS = {
  chrome: {
    label: "Google Chrome",
    configDir: () => join(configHome(), "google-chrome"),
  },
  chromium: {
    label: "Chromium",
    configDir: () => join(configHome(), "chromium"),
  },
  brave: {
    label: "Brave",
    configDir: () => join(configHome(), "BraveSoftware", "Brave-Browser"),
  },
};

function looksLikeProfile(dir) {
  for (const marker of ["Preferences", "Cookies", "History", "Login Data"]) {
    if (existsSync(join(dir, marker))) return true;
  }
  return false;
}

/**
 * Scan the known Linux browser config locations.
 * Returns [{ browser, label, configDir, found, profiles: [{ dir, path }] }].
 */
export async function listSourceBrowsers() {
  const result = [];
  for (const [browser, spec] of Object.entries(SOURCE_BROWSERS)) {
    const configDir = spec.configDir();
    const entry = {
      browser,
      label: spec.label,
      configDir,
      found: false,
      profiles: [],
    };
    let names;
    try {
      names = await readdir(configDir);
    } catch {
      result.push(entry);
      continue;
    }
    entry.found = true;
    for (const name of names) {
      const path = join(configDir, name);
      let isDir = false;
      try {
        isDir = (await stat(path)).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;
      // Real Chrome profile dirs are "Default" or "Profile N", but also
      // accept any directory that looks like a profile (copies/renames).
      if (
        name === "Default" ||
        /^Profile \d+$/.test(name) ||
        looksLikeProfile(path)
      ) {
        entry.profiles.push({ dir: name, path });
      }
    }
    result.push(entry);
  }
  return result;
}

// Cache, lock and log files are useless (and sometimes harmful) in a copy.
const SKIP_NAMES = new Set([
  "Cache",
  "Code Cache",
  "GPUCache",
  "ShaderCache",
  "Crashpad",
  "SingletonLock",
  "SingletonSocket",
  "SingletonCookie",
  "LOCK",
  "LOG",
]);

function copyFilter(src) {
  const base = basename(src);
  if (SKIP_NAMES.has(base)) return false;
  if (base.endsWith(".log")) return false;
  return true;
}

function profileIdFor(browser, dirName) {
  return `${browser}-${dirName.replace(/\s+/g, "")}`;
}

/**
 * Copy source browser profiles into the ego profile store.
 * `groups`: [{ browser, profileDirs: [] }] (empty profileDirs => Default).
 * Options: { clearExistingProfiles }.
 * Returns { imported: [{ id, name, sourcePath }] }.
 */
export async function importProfiles(groups, { clearExistingProfiles = false } = {}) {
  if (!groups || groups.length === 0) {
    throw new Error(
      "ego-browser import: no --browser given. Usage:\n" +
        "  ego-browser import --browser <browser> [--profile <dir-name> ...]",
    );
  }
  const sources = await listSourceBrowsers();
  const byBrowser = new Map(sources.map((s) => [s.browser, s]));
  const imported = [];
  for (const group of groups) {
    const spec = SOURCE_BROWSERS[group.browser];
    if (!spec) {
      throw new Error(
        `ego-browser import: unsupported browser "${group.browser}". ` +
          `Supported: ${Object.keys(SOURCE_BROWSERS).join(", ")}.`,
      );
    }
    const source = byBrowser.get(group.browser);
    if (!source.found) {
      throw new Error(
        `ego-browser import: ${spec.label} config directory not found: ${source.configDir}`,
      );
    }
    const dirNames =
      group.profileDirs && group.profileDirs.length > 0
        ? group.profileDirs
        : ["Default"];
    for (const dirName of dirNames) {
      const sourcePath = join(source.configDir, dirName);
      if (!existsSync(sourcePath) || !looksLikeProfile(sourcePath)) {
        throw new Error(
          `ego-browser import: profile "${dirName}" not found in ${spec.label} (${sourcePath})`,
        );
      }
      if (existsSync(join(sourcePath, "SingletonLock"))) {
        process.stderr.write(
          `warning: ${spec.label} looks like it is running; ` +
            `close it for a consistent copy (copying anyway).\n`,
        );
      }
      const id = profileIdFor(group.browser, dirName);
      // An ego profile is a Chromium user-data-dir; the imported browser
      // profile becomes its "Default" sub-profile, matching Chromium's
      // on-disk layout (<user-data-dir>/Default/Cookies).
      const egoProfileDir = join(PROFILES_DIR, id);
      const dest = join(egoProfileDir, "Default");
      await rm(egoProfileDir, { recursive: true, force: true });
      await mkdir(PROFILES_DIR, { recursive: true });
      await cp(sourcePath, dest, { recursive: true, filter: copyFilter });
      const name = `${spec.label}${dirName === "Default" ? "" : ` ${dirName}`}`;
      await writeFile(
        join(egoProfileDir, "profile.json"),
        JSON.stringify(
          {
            id,
            name,
            sourceBrowser: group.browser,
            sourceBrowserLabel: spec.label,
            sourceProfileDir: dirName,
            sourcePath,
            importedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
      imported.push({ id, name, sourcePath });
    }
  }
  if (clearExistingProfiles) {
    const importedIds = new Set(imported.map((p) => p.id));
    let names;
    try {
      names = await readdir(PROFILES_DIR);
    } catch {
      names = [];
    }
    for (const name of names) {
      if (importedIds.has(name)) continue;
      await rm(join(PROFILES_DIR, name), { recursive: true, force: true });
      process.stderr.write(`removed existing ego profile: ${name}\n`);
    }
  }
  return { imported };
}

export function formatSourceList(sources) {
  const lines = [];
  for (const source of sources) {
    if (!source.found) {
      lines.push(`${source.browser} (${source.label}): not found`);
      continue;
    }
    lines.push(`${source.browser} (${source.label}): ${source.configDir}`);
    if (source.profiles.length === 0) {
      lines.push("  (no profiles found)");
    }
    for (const profile of source.profiles) {
      lines.push(`  ${profile.dir}`);
    }
  }
  return lines.join("\n");
}
