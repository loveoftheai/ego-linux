import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { agentWorkspace } from "../env.js";
function learningsRoot(workspace = agentWorkspace()) {
  return join(workspace, "learnings");
}
const siteSkillsRoot = learningsRoot;
async function checkDomainLearningExists(urlOrDomain, options = {}) {
  const hostname = urlHostname(urlOrDomain);
  const root = options.root || learningsRoot(options.agentWorkspace || agentWorkspace());
  const matches = hostname ? await siteSkillsForUrl(hostname, { root }) : [];
  return {
    exists: matches.length > 0,
    hostname,
    root,
    matches
  };
}
async function checkLearningExists(siteId, options = {}) {
  const root = options.root || learningsRoot(options.agentWorkspace || agentWorkspace());
  const siteDir = join(root, siteId);
  const manifestPath = join(siteDir, "manifest.json");
  const exists = await pathExists(manifestPath);
  return {
    exists,
    root,
    siteDir,
    manifestPath
  };
}
async function siteSkillsForUrl(url, options = {}) {
  const hostname = urlHostname(url);
  if (!hostname) {
    return [];
  }
  const root = options.root || learningsRoot(options.agentWorkspace || agentWorkspace());
  const matches = [];
  for (const siteDir of await iterLearningDirs(root)) {
    let manifest;
    try {
      manifest = await loadLearningManifest(siteDir);
    } catch {
      continue;
    }
    const domains = Array.isArray(manifest.domains) ? manifest.domains : [];
    if (domains.some(
      (domain) => typeof domain === "string" && domainMatches(hostname, domain)
    )) {
      matches.push(learningEntry(siteDir, manifest));
    }
  }
  return matches;
}
async function iterLearningDirs(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith("_")).map((entry) => join(root, entry.name)).sort();
}
async function loadLearningManifest(siteDir) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(join(siteDir, "manifest.json"), "utf8"));
  } catch (error) {
    throw new Error(
      `site skill ${JSON.stringify(siteDir)} has invalid or missing manifest.json: ${error.message}`
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `site skill ${JSON.stringify(siteDir)} manifest must be an object`
    );
  }
  return parsed;
}
function learningEntry(siteDir, manifest) {
  const notes = Array.isArray(manifest.notes) ? manifest.notes : [];
  return {
    id: manifest.id || siteDir.split(/[\\/]/).at(-1),
    name: manifest.name || manifest.id || siteDir.split(/[\\/]/).at(-1),
    path: siteDir,
    domains: Array.isArray(manifest.domains) ? [...manifest.domains] : [],
    notes: notes.map((note) => join(siteDir, note)),
    nodeTools: toolSchemasNode(manifest),
    browserTools: toolSchemasBrowser(manifest)
  };
}
async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
function urlHostname(url) {
  try {
    const parsed = String(url).includes("://") ? new URL(String(url)) : new URL(`https://${url}`);
    return (parsed.hostname || "").toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
}
function domainMatches(hostname, pattern) {
  const normalized = String(pattern || "").toLowerCase().replace(/\.$/, "");
  if (normalized.startsWith("*.")) {
    const suffix = normalized.slice(2);
    return hostname.endsWith(`.${suffix}`);
  }
  return hostname === normalized;
}
function toolSchemasNode(manifest) {
  const value = manifest.nodeTools;
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return { ...value };
}
function toolSchemasBrowser(manifest) {
  const value = manifest.browserTools;
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return { ...value };
}
export {
  checkDomainLearningExists,
  checkLearningExists,
  iterLearningDirs,
  learningEntry,
  learningsRoot,
  loadLearningManifest,
  pathExists,
  siteSkillsForUrl,
  siteSkillsRoot,
  urlHostname
};
