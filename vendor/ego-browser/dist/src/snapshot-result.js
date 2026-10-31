import { validateLocatorBackendNodes } from "./element-resolver.js";
function compactSnapshotContent(content) {
  if (typeof content !== "string" || content.length === 0) return content;
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const trailingNewline = content.endsWith(newline);
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const rootIndex = lines.findIndex((line) => line.trim() === "root");
  if (rootIndex < 0) return content;
  const roots = [];
  const stack = [];
  for (const line of lines.slice(rootIndex)) {
    const indent = line.length - line.trimStart().length;
    if (indent % 2 !== 0) return content;
    const node = { text: line.trim(), children: [] };
    while (stack.length && stack.at(-1).indent >= indent) stack.pop();
    if (stack.length) stack.at(-1).node.children.push(node);
    else roots.push(node);
    stack.push({ indent, node });
  }
  const compacted = roots.flatMap(compactSnapshotNode);
  const rendered = [
    ...lines.slice(0, rootIndex),
    ...renderSnapshotTree(compacted)
  ].join(newline);
  return rendered + (trailingNewline ? newline : "");
}
function compactSnapshotResult(result) {
  if (!result || typeof result !== "object") return result;
  if (typeof result.content === "string") {
    result.content = compactSnapshotContent(result.content);
  }
  for (const ref of result.refs || []) {
    if (ref.loc === "unstable" || ref.loc === "ambiguous") delete ref.loc;
  }
  return result;
}
function compactSnapshotNode(node) {
  const text = omitUnusableLocatorStatus(node.text);
  const children = node.children.flatMap(compactSnapshotNode);
  if (isEmptySnapshotText(text)) return [];
  if (text === "container" && children.length === 0) return [];
  if (text === "container" && children.length === 1) return children;
  return [{ text, children }];
}
function omitUnusableLocatorStatus(text) {
  const metadataIndex = findSnapshotMetadataStart(text);
  if (metadataIndex < 0) return text;
  const metadata = text.slice(metadataIndex);
  if (!metadata.endsWith("]")) return text;
  const compacted = metadata.replace(
    /^(\[ref=[^,\]]+),\s*loc=(?:unstable|ambiguous)(?=,|\])/,
    "$1"
  );
  return compacted === metadata ? text : `${text.slice(0, metadataIndex)}${compacted}`;
}
function snapshotLineRefId(line) {
  const metadataIndex = findSnapshotMetadataStart(line);
  if (metadataIndex < 0) return void 0;
  const match = line.slice(metadataIndex).match(/^\[ref=([^,\]]+)/);
  return match ? match[1] : void 0;
}
function rewriteSnapshotRefIds(content, refIds) {
  return content.replace(/[^\r\n]+/g, (line) => {
    const start = findSnapshotMetadataStart(line);
    if (start < 0) return line;
    return line.slice(0, start) + line.slice(start).replace(
      /^\[ref=([^,\]]+)/,
      (metadata, refId) => refIds.has(refId) ? `[ref=${refIds.get(refId)}` : metadata
    );
  });
}
function findSnapshotMetadataStart(text) {
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && text.startsWith("[ref=", index) && (index === 0 || /\s/.test(text[index - 1]))) {
      return index;
    }
  }
  return -1;
}
function isEmptySnapshotText(text) {
  if (text === "text") return true;
  const match = text.match(/^text\s+("(?:\\.|[^"\\])*")$/);
  if (!match) return false;
  try {
    const value = JSON.parse(match[1]);
    return typeof value === "string" && value.replace(/[\s\p{Cf}]/gu, "") === "";
  } catch {
    return false;
  }
}
function renderSnapshotTree(nodes, depth = 0, output = []) {
  for (const node of nodes) {
    output.push(`${"  ".repeat(depth)}${node.text}`);
    renderSnapshotTree(node.children, depth + 1, output);
  }
  return output;
}
async function validateSnapshotLocator(cdp, pageSessionId, iframeSessions, ref) {
  const candidates = snapshotLocatorCandidates([ref]);
  if (candidates.length === 0) return false;
  const valid = await validateLocatorBackendNodes(
    cdp,
    pageSessionId,
    iframeSessions,
    candidates
  );
  return valid.has(0);
}
async function sanitizeSnapshotLocators(result, validator) {
  if (!Array.isArray(result?.refs)) return result;
  const invalidLocators = /* @__PURE__ */ new Map();
  for (const ref of result.refs) {
    const locator = ref?.loc;
    if (typeof locator !== "string" || locator === "unstable" || locator === "ambiguous") {
      continue;
    }
    if (await validator(ref)) continue;
    delete ref.loc;
    const refId = ref.refId ?? ref.backendNodeId;
    if (refId !== void 0) {
      const refLocators = invalidLocators.get(String(refId)) ?? /* @__PURE__ */ new Set();
      refLocators.add(locator);
      invalidLocators.set(String(refId), refLocators);
    }
  }
  if (typeof result.content === "string" && invalidLocators.size > 0) {
    result.content = omitSnapshotLocators(result.content, invalidLocators);
  }
  return result;
}
function omitSnapshotLocators(content, invalidLocators) {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  return content.split(/\r?\n/).map((line) => omitSnapshotLineLocator(line, invalidLocators)).join(newline);
}
function omitSnapshotLineLocator(text, invalidLocators) {
  const metadataIndex = findSnapshotMetadataStart(text);
  if (metadataIndex < 0) return text;
  const metadata = text.slice(metadataIndex);
  if (!metadata.endsWith("]")) return text;
  const prefix = metadata.match(/^\[ref=([^,\]]+),\s*loc=/);
  if (!prefix) return text;
  const candidates = invalidLocators.get(prefix[1]);
  if (!candidates) return text;
  for (const locator of candidates) {
    const locatorEnd = prefix[0].length + locator.length;
    if (metadata.startsWith(locator, prefix[0].length) && (metadata[locatorEnd] === "," || metadata[locatorEnd] === "]")) {
      return `${text.slice(0, metadataIndex)}[ref=${prefix[1]}${metadata.slice(locatorEnd)}`;
    }
  }
  return text;
}
async function preparePageSnapshotResult(services, pageSessionId, iframeSessions, result, rootContext = {}) {
  const adapter = {
    sendRaw: (method, params = {}, sessionId) => services.cdp(method, params, sessionId)
  };
  const refs = result?.refs || [];
  const descendantRefIds = typeof result?.content === "string" ? iframeDescendantRefIds(result.content) : /* @__PURE__ */ new Set();
  const validIndexes = await validateLocatorBackendNodes(
    adapter,
    pageSessionId,
    iframeSessions,
    snapshotLocatorCandidates(refs)
  );
  const validRefs = new Set(refs.filter((_, index) => validIndexes.has(index)));
  await backfillSnapshotFrameIds(
    adapter,
    pageSessionId,
    iframeSessions,
    result,
    descendantRefIds
  );
  for (const ref of refs) {
    const refId = ref.refId ?? ref.backendNodeId;
    if (ref.frameId) {
      ref.frameProvenance = "frame";
    } else if (refId !== void 0 && descendantRefIds.has(String(refId))) {
      ref.frameProvenance = "unknown";
    } else if (rootContext.frameId) {
      ref.frameId = rootContext.frameId;
      ref.frameProvenance = "frame";
    } else {
      ref.frameProvenance = rootContext.frameProvenance ?? "page";
    }
  }
  return sanitizeSnapshotLocators(result, async (ref) => validRefs.has(ref));
}
async function backfillSnapshotFrameIds(cdp, pageSessionId, iframeSessions, result, descendantRefIds) {
  if (iframeSessions.size === 0 || typeof result.content !== "string") return;
  const missing = (result.refs || []).filter((ref) => {
    const refId = ref.refId ?? ref.backendNodeId;
    return !ref.frameId && refId !== void 0 && descendantRefIds.has(String(refId));
  });
  if (missing.length === 0) return;
  const frameIds = [...iframeSessions.keys()];
  if (frameIds.length === 1) {
    for (const ref of missing) ref.frameId = frameIds[0];
    return;
  }
  const owners = /* @__PURE__ */ new Map();
  const candidates = [];
  for (const ref of missing) {
    const base = snapshotLocatorCandidates([ref])[0];
    if (!base) continue;
    for (const frameId of frameIds) {
      const index = candidates.length;
      candidates.push({ ...base, index, frameId });
      owners.set(index, { frameId, ref });
    }
  }
  const valid = await validateLocatorBackendNodes(
    cdp,
    pageSessionId,
    iframeSessions,
    candidates
  );
  const matches = /* @__PURE__ */ new Map();
  for (const index of valid) {
    const owner = owners.get(index);
    if (!owner) continue;
    const frameMatches = matches.get(owner.ref) ?? /* @__PURE__ */ new Set();
    frameMatches.add(owner.frameId);
    matches.set(owner.ref, frameMatches);
  }
  for (const [ref, frameMatches] of matches) {
    if (frameMatches.size === 1) ref.frameId = [...frameMatches][0];
  }
}
function iframeDescendantRefIds(content) {
  const refs = /* @__PURE__ */ new Set();
  let iframeIndent;
  let frameRootIndent;
  for (const line of content.split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    const indent = line.length - line.trimStart().length;
    const startsIframe = /^iframe(?:\s|$)/.test(text);
    if (iframeIndent === void 0) {
      if (startsIframe) iframeIndent = indent;
      continue;
    }
    if (frameRootIndent === void 0) {
      if (/^root(?:\s|$)/.test(text) && indent >= iframeIndent) {
        frameRootIndent = indent;
      } else if (indent <= iframeIndent) {
        iframeIndent = startsIframe ? indent : void 0;
      }
      continue;
    }
    if (indent <= frameRootIndent) {
      iframeIndent = startsIframe ? indent : void 0;
      frameRootIndent = void 0;
      continue;
    }
    const refId = snapshotLineRefId(line);
    if (refId !== void 0) refs.add(refId);
  }
  return refs;
}
function snapshotLocatorCandidates(refs) {
  return refs.flatMap((ref, index) => {
    if (!Number.isInteger(ref.backendNodeId) || typeof ref.loc !== "string" || ref.loc.length === 0 || ref.loc === "unstable" || ref.loc === "ambiguous") {
      return [];
    }
    return [
      {
        index,
        locator: ref.loc.startsWith("loc=") ? ref.loc : `loc=${ref.loc}`,
        backendNodeId: ref.backendNodeId,
        ...ref.frameId ? { frameId: ref.frameId } : {}
      }
    ];
  });
}
export {
  compactSnapshotContent,
  compactSnapshotResult,
  preparePageSnapshotResult,
  rewriteSnapshotRefIds,
  sanitizeSnapshotLocators,
  validateSnapshotLocator
};
