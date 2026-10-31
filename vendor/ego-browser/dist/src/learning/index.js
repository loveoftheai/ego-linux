import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import {
  iterLearningDirs,
  learningEntry,
  loadLearningManifest,
  siteSkillsForUrl,
  siteSkillsRoot,
  urlHostname
} from "./check-domain-learning.js";
import {
  checkDomainLearningExists,
  checkLearningExists,
  iterLearningDirs as iterLearningDirs2,
  learningsRoot,
  pathExists,
  siteSkillsForUrl as siteSkillsForUrl2,
  siteSkillsRoot as siteSkillsRoot2
} from "./check-domain-learning.js";
import {
  validateLearning,
  validateLearnings,
  validateSiteSkills
} from "./validate-learning-format.js";
async function loadLearnedContext(url, options = {}) {
  const matches = await siteSkillsForUrl(url, options);
  if (matches.length === 0) {
    return {
      exists: false,
      siteId: null,
      siteName: null,
      domain: urlHostname(url),
      knowledge: [],
      tools: []
    };
  }
  const toolSignatures = [];
  const knowledgeNotes = [];
  for (const entry of matches) {
    const siteId = entry.id;
    for (const notePath of entry.notes) {
      if (!isLearningNotePath(entry.path, notePath)) {
        continue;
      }
      let content;
      try {
        content = await readFile(notePath, "utf8");
      } catch {
        continue;
      }
      const fileName = notePath.split(/[\\/]/).pop() || "";
      knowledgeNotes.push({ siteId, fileName, content });
    }
    const nodeTools = entry.nodeTools || {};
    for (const [toolName, schema] of Object.entries(nodeTools)) {
      toolSignatures.push({
        siteId,
        toolName,
        toolType: "node",
        description: schema.description || "",
        args: schema.args || {},
        example: `await runSiteTool("${siteId}", "${toolName}", { ... })`
      });
    }
    const browserTools = entry.browserTools || {};
    for (const [toolName, schema] of Object.entries(browserTools)) {
      toolSignatures.push({
        siteId,
        toolName,
        toolType: "browser",
        description: schema.description || "",
        args: schema.args || {},
        example: `await runSiteBrowserTool("${siteId}", "${toolName}", { ... })`
      });
    }
  }
  return {
    exists: true,
    siteId: matches[0].id,
    siteName: matches[0].name,
    domain: urlHostname(url),
    knowledge: knowledgeNotes,
    tools: toolSignatures
  };
}
function isLearningNotePath(siteDir, notePath) {
  const relativePath = relative(resolve(siteDir), resolve(notePath));
  const parts = relativePath.split(/[\\/]/);
  return parts.length === 2 && parts[0] === "notes" && parts[1].endsWith(".md") && parts.every((part) => part && part !== "." && part !== "..");
}
async function findSiteSkill(siteId, options = {}) {
  const root = options.root || siteSkillsRoot(options.agentWorkspace);
  for (const siteDir of await iterLearningDirs(root)) {
    const manifest = await loadLearningManifest(siteDir);
    if (manifest.id === siteId) {
      return { siteDir, manifest };
    }
  }
  throw siteSkillNotFoundError(siteId, root);
}
async function runNodeSiteTool(siteId, toolName, args = {}, ctx, options = {}) {
  const { siteDir, manifest } = await findSiteSkill(siteId, options);
  const schema = toolSchemas(manifest, "nodeTools")[toolName];
  if (!schema || typeof schema !== "object") {
    throw new Error(
      `Node tool ${JSON.stringify(toolName)} is not declared by site skill ${JSON.stringify(siteId)}`
    );
  }
  const toolPath = relativeSitePath(siteDir, schema.path, "Node tool");
  const module = await import(`${pathToFileURL(toolPath).href}?t=${Date.now()}`);
  const callableName = schema.callable;
  if (typeof callableName !== "string" || !callableName.trim()) {
    throw new Error(
      `Node tool ${JSON.stringify(toolName)} must declare a callable`
    );
  }
  const tool = module[callableName];
  if (typeof tool !== "function") {
    throw new Error(
      `site skill ${JSON.stringify(siteId)} is missing Node callable ${JSON.stringify(callableName)}`
    );
  }
  return tool(ctx, args || {});
}
async function loadBrowserToolSource(siteId, toolName, options = {}) {
  const { siteDir, manifest } = await findSiteSkill(siteId, options);
  const schema = toolSchemas(manifest, "browserTools")[toolName];
  if (!schema || typeof schema !== "object") {
    throw new Error(
      `browser tool ${JSON.stringify(toolName)} is not declared by site skill ${JSON.stringify(siteId)}`
    );
  }
  const toolPath = relativeSitePath(siteDir, schema.path, "browser tool");
  return readFile(toolPath, "utf8");
}
function wrapBrowserTool(source, args = {}) {
  return `(async () => { const __egoBrowserTool = ${source}; return await __egoBrowserTool(${JSON.stringify(args || {})}); })()`;
}
function siteSkillNotFoundError(siteId, searchedRoot) {
  const workspace = process.env.EGO_BROWSER_AGENT_WORKSPACE || "unset";
  const lines = [
    `site skill not found: ${JSON.stringify(siteId)}`,
    `  searched: ${searchedRoot}`,
    `  EGO_BROWSER_AGENT_WORKSPACE: ${workspace}`,
    `  hint: ensure your write path begins with the searched root above`
  ];
  return new Error(lines.join("\n"));
}
function toolSchemas(manifest, key) {
  const value = manifest[key] || {};
  return value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
}
function relativeSitePath(siteDir, manifestPath, label) {
  if (typeof manifestPath !== "string" || !manifestPath.trim()) {
    throw new Error(`${label} path must be a non-empty relative path`);
  }
  if (manifestPath.includes("\\") || isAbsolute(manifestPath) || manifestPath.split("/").includes("..")) {
    throw new Error(
      `${label} path must be relative to the site skill directory`
    );
  }
  const resolved = resolve(siteDir, manifestPath);
  const siteRoot = resolve(siteDir);
  if (resolved !== siteRoot && !resolved.startsWith(`${siteRoot}/`)) {
    throw new Error(`${label} path must stay inside the site skill directory`);
  }
  return resolved;
}
export {
  checkDomainLearningExists,
  checkLearningExists,
  findSiteSkill,
  iterLearningDirs2 as iterLearningDirs,
  learningEntry,
  learningsRoot,
  loadBrowserToolSource,
  loadLearnedContext,
  pathExists,
  runNodeSiteTool,
  siteSkillsForUrl2 as siteSkillsForUrl,
  siteSkillsRoot2 as siteSkillsRoot,
  validateLearning,
  validateLearnings,
  validateSiteSkills,
  wrapBrowserTool
};
