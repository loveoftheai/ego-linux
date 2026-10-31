// Snapshot engine for the Linux CDP binding layer.
//
// Produces the same `{ content, refs }` shape as the native `ego.snapshot()`
// in the closed-source ego lite app (see repo/docs/native-bindings-api.md):
//
//   content: text tree, first line `root`, two-space indentation, node lines
//            `role "name" [ref=N, loc=..., url=...]` (parts appear only when
//            present).
//   refs:    [{ refId, backendNodeId, role, name, loc? }] for every
//            actionable node, refId unique within the snapshot, assigned in
//            document order.
//
// Data source: CDP `Accessibility.getFullAXTree` (AX role/name plus
// `backendDOMNodeId` per node) — the same AX+DOM correlation the native
// engine performs in C++. Viewport scope is approximated with
// `DOMSnapshot` layout bounds; see progress notes for known gaps.

/** AX role -> role printed by ego's snapshot (ego display vocabulary). */
const ROLE_MAP = {
  RootWebArea: "root",
  link: "anchor",
  generic: "container",
  genericContainer: "container",
  group: "container",
  none: "container",
  presentation: "container",
  region: "container",
  StaticText: "text",
  listitem: "list_item",
  cell: "table_cell",
  gridcell: "table_cell",
  textbox: "textfield",
  option: "listboxoption",
  Iframe: "iframe",
};

/** Printed roles that receive a [ref=N] and a refs[] entry. */
const ACTIONABLE_ROLES = new Set([
  "button",
  "anchor",
  "textfield",
  "searchbox",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "listboxoption",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "switch",
  "slider",
  "spinbutton",
  "iframe",
]);

const ZERO_WIDTH_OR_SPACE = /^[\s​‌‍⁠﻿]*$/;

function axString(value) {
  if (!value) return "";
  const raw = value.value;
  return raw === undefined || raw === null ? "" : String(raw);
}

function printedRole(axRole, insideTable) {
  if (axRole === "row") return insideTable ? "table_row" : "row";
  return ROLE_MAP[axRole] || axRole || "container";
}

function escapeName(name) {
  return name
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\s*\n\s*/g, " ");
}

/**
 * Build a snapshot for one attached page session.
 *
 * @param {{call(method: string, params?: object, sessionId?: string): Promise<any>}} transport
 * @param {string} sessionId CDP session of the page target (flatten mode).
 * @param {object} [options] Native snapshot options (scope, root, ...).
 * @returns {Promise<{content: string, refs: object[]}>}
 */
export async function buildSnapshot(transport, sessionId, options = {}) {
  const scope = options.scope ?? "full_page";
  if (
    scope !== "full_page" &&
    scope !== "only_within_viewport" &&
    scope !== "subtree"
  ) {
    throw snapshotError(
      `ego.snapshot(options?) expects an options object with scope 'only_within_viewport', 'full_page', or 'subtree'.`,
      "EGO_INVALID_ARGUMENT",
      true,
    );
  }
  if (scope === "subtree" && typeof options.root !== "number") {
    throw snapshotError(
      "ego.snapshot() root is only valid with scope: 'subtree' and is required there.",
      "EGO_INVALID_ARGUMENT",
      true,
    );
  }
  if (scope !== "subtree" && options.root !== undefined) {
    throw snapshotError(
      "ego.snapshot() root is only valid with scope: 'subtree'.",
      "EGO_INVALID_ARGUMENT",
      true,
    );
  }

  let axResult;
  try {
    await transport
      .call("Accessibility.enable", {}, sessionId)
      .catch(() => {});
    axResult = await transport.call(
      "Accessibility.getFullAXTree",
      {},
      sessionId,
    );
  } catch (error) {
    throw snapshotError(
      `Failed to capture accessibility tree: ${error.message}`,
      "EGO_SNAPSHOT_FAILED",
    );
  }
  const axNodes = axResult.nodes || [];
  if (axNodes.length === 0) {
    throw snapshotError("Snapshot returned no nodes", "EGO_SNAPSHOT_FAILED");
  }

  // Index AX nodes and record parent links.
  const byId = new Map();
  for (const node of axNodes) byId.set(node.nodeId, node);
  const parentOf = new Map();
  for (const node of axNodes) {
    for (const childId of node.childIds || []) parentOf.set(childId, node.nodeId);
  }
  const rootAx =
    axNodes.find((node) => axString(node.role) === "RootWebArea") ||
    axNodes.find((node) => !parentOf.has(node.nodeId));
  if (!rootAx) {
    throw snapshotError("Snapshot has no root node", "EGO_SNAPSHOT_FAILED");
  }

  // Convert the AX tree into a plain node tree. Ignored nodes are flattened
  // (children spliced into the parent) unless they carry a name; inline text
  // boxes are dropped because their text is already on the StaticText parent.
  // byId maps AX nodeId -> node for the tree being converted (main frame or
  // one OOPIF document).
  function convert(axNode, byId, insideTable) {
    const axRole = axString(axNode.role);
    const name = axString(axNode.name);
    const role = printedRole(axRole, insideTable);
    const childInsideTable =
      insideTable || axRole === "table" || axRole === "grid" || axRole === "treegrid";
    const children = [];
    for (const childId of axNode.childIds || []) {
      const child = byId.get(childId);
      if (!child) continue;
      children.push(...convert(child, byId, childInsideTable));
    }
    if (axRole === "InlineTextBox") return [];
    if (axNode.ignored && !name) {
      // Pruned structural node: keep only its (converted) children.
      return children;
    }
    if (role === "text" && ZERO_WIDTH_OR_SPACE.test(name)) return [];
    return [
      {
        role,
        name,
        backendNodeId:
          typeof axNode.backendDOMNodeId === "number"
            ? axNode.backendDOMNodeId
            : undefined,
        children,
      },
    ];
  }

  let forest;
  // For subtree scope the root backendNodeId may live in any frame's
  // document (e.g. an element inside an iframe), not just the main frame.
  // The native implementation matches it across all frames and reports an
  // ambiguity error if several frames contain the same id.
  let subtreeById = byId;
  let subtreeFrameId = null;
  if (scope === "subtree") {
    let target = axNodes.find(
      (node) => node.backendDOMNodeId === options.root,
    );
    if (!target) {
      const found = await findAxNodeAcrossFrames(
        transport,
        sessionId,
        options.root,
      );
      if (found.length === 0) {
        throw snapshotError(
          `ego.snapshot() subtree root backendNodeId ${options.root} was not found.`,
          "EGO_SNAPSHOT_FAILED",
        );
      }
      if (found.length > 1) {
        throw snapshotError(
          `ego.snapshot() subtree root backendNodeId ${options.root} is ambiguous across ${found.length} frames.`,
          "EGO_SNAPSHOT_FAILED",
        );
      }
      target = found[0].node;
      subtreeById = found[0].byId;
      subtreeFrameId = found[0].frameId;
    }
    const converted = convert(target, subtreeById, false);
    // Tag refs from a non-main frame so they bind to the right document.
    if (subtreeFrameId) {
      walk(converted, (n) => {
        if (n.frameId === undefined) n.frameId = subtreeFrameId;
      });
    }
    forest = [{ role: "root", name: "", children: converted }];
  } else {
    const converted = convert(rootAx, byId, false);
    const tree =
      converted.length === 1 && converted[0].role === "root"
        ? converted[0]
        : { role: "root", name: "", children: converted };
    tree.role = "root";
    forest = [tree];
  }

  // Scope filters that keep a node plus its ancestors.
  if (scope === "only_within_viewport") {
    const keep = await viewportKeepSet(transport, sessionId, axNodes);
    if (keep) pruneToKeepSet(forest, keep);
  }
  // Cross-site iframes run out-of-process (site isolation): their content is
  // absent from the main AX tree, so pull each OOPIF document's own AX tree
  // and graft it under its <iframe> node — the same traversal the native
  // engine performs in C++. Runs after viewport pruning so only visible
  // iframes pay the extra round trips, mirroring "visible iframe content".
  // Subtree snapshots also graft: a subtree rooted at (or containing) an
  // <iframe> must expand its content.
  await graftOopifFrames(transport, sessionId, forest, convert).catch(
    () => {},
  );
  // Same-origin iframes stay in-process (no separate target): their content
  // is absent from the main AX tree, so pull each frame's own AX tree via
  // Accessibility.getFullAXTree({ frameId }) and graft it under its <iframe>
  // node. Like the OOPIF graft, this mirrors the native engine's traversal.
  await graftInProcessFrames(transport, sessionId, forest, convert).catch(
    () => {},
  );
  if (options.interactiveOnly) {
    pruneToKeepSet(forest, null, (node) => ACTIONABLE_ROLES.has(node.role));
  }

  // Assign refs in document order and collect anchor URLs.
  const refs = [];
  const refByNode = new Map();
  let nextRefId = 1;
  walk(forest, (node) => {
    if (
      ACTIONABLE_ROLES.has(node.role) &&
      typeof node.backendNodeId === "number"
    ) {
      const refId = nextRefId++;
      refByNode.set(node, refId);
      refs.push({
        refId,
        backendNodeId: node.backendNodeId,
        role: node.role,
        name: node.name,
        node,
        frameId: node.frameId,
      });
    }
  });

  if (options.includeStableLocator) {
    const counts = new Map();
    for (const ref of refs) {
      if (!ref.name) continue;
      const key = `${ref.role} ${ref.name}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    for (const ref of refs) {
      if (!ref.name || ref.role === "anchor") continue;
      if (/["\n]/.test(ref.name)) continue;
      if (counts.get(`${ref.role} ${ref.name}`) === 1) {
        ref.loc = `role:${ref.role}[name=${JSON.stringify(ref.name)}]`;
      }
    }
  }

  // Resolve hrefs for anchors so content can print url= like the native one.
  // OOPIF anchors resolve in their own document's session (done during
  // grafting, while the session is still attached).
  const anchorRefs = refs.filter((ref) => ref.role === "anchor");
  for (const ref of anchorRefs.slice(0, 200)) {
    if (ref.node.urlResolved) {
      ref.url = ref.node.url;
      continue;
    }
    ref.url = await resolveAnchorUrl(
      transport,
      ref.node.sessionId || sessionId,
      ref.backendNodeId,
    ).catch(() => undefined);
  }

  // Stable href locators for anchors: a unique href gets loc=href:<href>
  // (the SDK resolves loc=href: as a substring match). Duplicated hrefs get
  // no locator, mirroring the native rule. The href attribute form is used,
  // not the resolved absolute URL.
  if (options.includeStableLocator) {
    const hrefCounts = new Map();
    const rawHrefs = new Map();
    for (const ref of anchorRefs) {
      // OOPIF anchors captured rawHref during grafting (session detached).
      let rawHref = ref.node.rawHref;
      if (typeof rawHref !== "string") {
        try {
          rawHref = await resolveAnchorRawHref(
            transport,
            ref.node.sessionId || sessionId,
            ref.backendNodeId,
          ).catch(() => undefined);
        } catch {
          rawHref = undefined;
        }
      }
      if (typeof rawHref === "string" && rawHref.length > 0) {
        rawHrefs.set(ref, rawHref);
        hrefCounts.set(rawHref, (hrefCounts.get(rawHref) || 0) + 1);
      }
    }
    for (const ref of anchorRefs) {
      const rawHref = rawHrefs.get(ref);
      if (
        typeof rawHref === "string" &&
        hrefCounts.get(rawHref) === 1 &&
        !/["\n]/.test(rawHref)
      ) {
        ref.loc = `href:${rawHref}`;
      }
    }
  }

  // Serialize.
  const lines = ["root"];
  function render(node, depth) {
    if (node.role === "root") {
      for (const child of node.children) render(child, depth);
      return;
    }
    const indent = "  ".repeat(depth);
    let line = indent + node.role;
    if (node.name) line += ` "${escapeName(node.name)}"`;
    const ref = refs.find((entry) => entry.node === node);
    const marks = [];
    if (ref) {
      marks.push(`ref=${ref.refId}`);
      if (ref.loc) marks.push(`loc=${ref.loc}`);
      if (ref.url) marks.push(`url=${ref.url}`);
    }
    if (marks.length) line += ` [${marks.join(", ")}]`;
    lines.push(line);
    for (const child of node.children) render(child, depth + 1);
  }
  for (const top of forest) render(top, 1);

  let content = lines.join("\n");
  if (
    typeof options.maxResultLength === "number" &&
    options.maxResultLength > 0 &&
    content.length > options.maxResultLength
  ) {
    content = content.slice(0, options.maxResultLength);
  }

  return {
    content,
    refs: refs.map((ref) => {
      const out = {
        refId: ref.refId,
        backendNodeId: ref.backendNodeId,
        role: ref.role,
        name: ref.name,
      };
      if (ref.loc) out.loc = ref.loc;
      // OOPIF refs carry their document's frame id so the SDK binds actions
      // to the right frame; backendNodeIds are only unique per document.
      if (ref.frameId) out.frameId = ref.frameId;
      return out;
    }),
  };
}

function walk(nodes, visit) {
  for (const node of nodes) {
    visit(node);
    walk(node.children, visit);
  }
}

/**
 * Graft out-of-process iframe (OOPIF) documents into the snapshot tree.
 *
 * With site isolation on, a cross-site <iframe> is a separate CDP target of
 * type "iframe": the main frame's AX tree holds the Iframe node but none of
 * its content. The native engine traverses OOPIF documents directly; this
 * mirrors that by pulling each OOPIF's own AX tree and grafting it under its
 * <iframe> node. Grafted nodes are tagged with the OOPIF's frame id (refs
 * need it: backendNodeIds are only unique per document) and session id (so
 * anchor href resolution runs in the right document).
 *
 * Matching is by the <iframe> element's src attribute against the iframe
 * target's URL, scoped to OOPIF targets whose parent frame belongs to this
 * page (Target.getTargets is browser-wide; other pages may host identical
 * iframe URLs). When exactly one page-owned iframe node and one page-owned
 * target remain unmatched they are paired as a fallback.
 */
async function graftOopifFrames(transport, sessionId, forest, convert) {
  const iframeNodes = [];
  walk(forest, (node) => {
    if (node.role === "iframe" && typeof node.backendNodeId === "number") {
      iframeNodes.push(node);
    }
  });
  if (iframeNodes.length === 0) return;

  let targetInfos = [];
  try {
    const result = await transport.call("Target.getTargets");
    targetInfos = (result.targetInfos || []).filter(
      (info) => info.type === "iframe",
    );
  } catch {
    return;
  }
  if (targetInfos.length === 0) return;

  // Scope OOPIF targets to THIS page. Target.getTargets is browser-wide, so
  // other pages (or earlier agent runs sharing the browser) can host iframes
  // with byte-identical URLs; URL-only matching then grafts another page's
  // document and stamps its refs with a foreign frame id, which fails the
  // SDK's document-stability check ("Page changed during snapshot"). An OOPIF
  // target belongs to this page only when its parent frame is one of this
  // page's frames. The set grows as grafted OOPIFs report their frame ids,
  // so nested OOPIFs (parent = outer OOPIF's frame) keep matching.
  const pageFrameIds = new Set();
  try {
    const ft = await transport.call("Page.getFrameTree", {}, sessionId);
    const tree = (ft && (ft.frameTree || ft.result?.frameTree)) || null;
    const collect = (node) => {
      if (node && node.frame && typeof node.frame.id === "string") {
        pageFrameIds.add(node.frame.id);
      }
      for (const child of (node && node.childFrames) || []) collect(child);
    };
    if (tree) collect(tree);
  } catch {
    // No frame info: fall back to URL-only matching below.
  }
  const belongsToPage = (info) => {
    if (pageFrameIds.size === 0) return true;
    const parent = info.parentFrameId || info.parentId;
    return typeof parent === "string" && pageFrameIds.has(parent);
  };

  // Resolve each <iframe> element's src from the main document.
  const srcByNode = new Map();
  for (const node of iframeNodes) {
    try {
      const described = await transport.call(
        "DOM.describeNode",
        { backendNodeId: node.backendNodeId, depth: 0 },
        sessionId,
      );
      const attrs = (described.node && described.node.attributes) || [];
      for (let i = 0; i + 1 < attrs.length; i += 2) {
        if (attrs[i] === "src") {
          srcByNode.set(node, attrs[i + 1] || "");
          break;
        }
      }
    } catch {
      // Leave unmatched; the fallback below may still pair it.
    }
  }

  const usedTargets = new Set();
  const unmatchedNodeCount = () =>
    iframeNodes.filter((n) => !matchedNodes.has(n)).length;
  const matchedNodes = new Set();
  const matchTarget = (node) => {
    const src = srcByNode.get(node) || "";
    for (const info of targetInfos) {
      if (usedTargets.has(info.targetId)) continue;
      if (!belongsToPage(info)) continue;
      if (src && info.url && (info.url === src || info.url.endsWith(src))) {
        usedTargets.add(info.targetId);
        matchedNodes.add(node);
        return info;
      }
    }
    // Fallback: a single ambiguous pairing is better than dropping content,
    // but only among targets that belong to this page — pairing a foreign
    // page's OOPIF is worse than omitting the content.
    const remaining = targetInfos.filter(
      (i) => !usedTargets.has(i.targetId) && belongsToPage(i),
    );
    if (remaining.length === 1 && unmatchedNodeCount() === 1) {
      usedTargets.add(remaining[0].targetId);
      matchedNodes.add(node);
      return remaining[0];
    }
    return null;
  };

  for (const node of iframeNodes) {
    const target = matchTarget(node);
    if (!target) continue;
    let oopifSession = null;
    try {
      const attached = await transport.call("Target.attachToTarget", {
        targetId: target.targetId,
        flatten: true,
      });
      oopifSession = attached.sessionId;
      if (!oopifSession) continue;
      await transport
        .call("Accessibility.enable", {}, oopifSession)
        .catch(() => {});
      const axResult = await transport.call(
        "Accessibility.getFullAXTree",
        {},
        oopifSession,
      );
      const frameTree = await transport
        .call("Page.getFrameTree", {}, oopifSession)
        .catch(() => null);
      const oopifNodes = (axResult && axResult.nodes) || [];
      if (oopifNodes.length === 0) continue;
      const byId = new Map();
      for (const axNode of oopifNodes) byId.set(axNode.nodeId, axNode);
      const parentOf = new Map();
      for (const axNode of oopifNodes) {
        for (const childId of axNode.childIds || [])
          parentOf.set(childId, axNode.nodeId);
      }
      const rootAx =
        oopifNodes.find((n) => axString(n.role) === "RootWebArea") ||
        oopifNodes.find((n) => !parentOf.has(n.nodeId));
      if (!rootAx) continue;
      const frameId =
        frameTree && frameTree.frameTree && frameTree.frameTree.frame
          ? frameTree.frameTree.frame.id
          : undefined;
      if (typeof frameId === "string") pageFrameIds.add(frameId);
      const grafted = [];
      for (const childId of rootAx.childIds || []) {
        const child = byId.get(childId);
        if (child) grafted.push(...convert(child, byId, false));
      }
      // Tag the whole grafted subtree so refs bind to the OOPIF document.
      const graftedAnchors = [];
      walk(grafted, (n) => {
        n.frameId = frameId;
        n.sessionId = oopifSession;
        if (n.role === "anchor" && typeof n.backendNodeId === "number") {
          graftedAnchors.push(n);
        }
      });
      // Resolve OOPIF anchor hrefs now: the session is detached below, and
      // the later batch resolution runs against already-detached sessions.
      // Capture the raw href attribute too, for loc=href: generation.
      for (const anchorNode of graftedAnchors.slice(0, 50)) {
        anchorNode.url = await resolveAnchorUrl(
          transport,
          oopifSession,
          anchorNode.backendNodeId,
        ).catch(() => undefined);
        anchorNode.rawHref = await resolveAnchorRawHref(
          transport,
          oopifSession,
          anchorNode.backendNodeId,
        ).catch(() => undefined);
        anchorNode.urlResolved = true;
      }
      if (node.children.length === 0) node.children = grafted;
      else node.children.push(...grafted);
    } catch {
      // An unloadable or detached OOPIF degrades to a bare iframe node.
    } finally {
      if (oopifSession) {
        await transport
          .call("Target.detachFromTarget", { sessionId: oopifSession })
          .catch(() => {});
      }
    }
  }
}

/**
 * Graft in-process (same-origin) iframe documents into the snapshot tree.
 *
 * Accessibility.getFullAXTree only returns the main frame's nodes; same-origin
 * <iframe> content lives in child frames of Page.getFrameTree (no separate CDP
 * target, so the OOPIF graft never sees them). For each child frame, resolve
 * its owner <iframe> element via DOM.getFrameOwner, pull the frame's own AX
 * tree with Accessibility.getFullAXTree({ frameId }), and graft it under the
 * <iframe> node. Grafted nodes are tagged with the frame id so refs bind to
 * the right document. Frames are visited parents-first so nested iframes find
 * their (already grafted) owner nodes.
 */
async function graftInProcessFrames(transport, sessionId, forest, convert) {
  let frameTree;
  try {
    const ft = await transport.call("Page.getFrameTree", {}, sessionId);
    frameTree = (ft && (ft.frameTree || ft.result?.frameTree)) || null;
  } catch {
    return;
  }
  const childFrames = (frameTree && frameTree.childFrames) || [];
  if (childFrames.length === 0) return;

  const findIframeNode = (backendNodeId) => {
    let found = null;
    walk(forest, (node) => {
      if (
        !found &&
        node.role === "iframe" &&
        node.backendNodeId === backendNodeId &&
        node.children.length === 0
      ) {
        found = node;
      }
    });
    return found;
  };

  // Parents before children: a nested frame's owner lives in its parent
  // frame's (already grafted) content.
  const queue = [...childFrames];
  while (queue.length > 0) {
    const frameNode = queue.shift();
    const frameId =
      frameNode && frameNode.frame && frameNode.frame.id;
    const grandchildren = (frameNode && frameNode.childFrames) || [];
    if (grandchildren.length > 0) queue.push(...grandchildren);
    if (typeof frameId !== "string" || frameId.length === 0) continue;

    let ownerBackendNodeId;
    try {
      const owner = await transport.call(
        "DOM.getFrameOwner",
        { frameId },
        sessionId,
      );
      ownerBackendNodeId = owner && owner.backendNodeId;
    } catch {
      continue;
    }
    if (typeof ownerBackendNodeId !== "number") continue;
    const iframeNode = findIframeNode(ownerBackendNodeId);
    if (!iframeNode) continue;

    let axResult;
    try {
      axResult = await transport.call(
        "Accessibility.getFullAXTree",
        { frameId },
        sessionId,
      );
    } catch {
      continue;
    }
    const frameAxNodes = (axResult && axResult.nodes) || [];
    if (frameAxNodes.length === 0) continue;
    const byId = new Map();
    for (const axNode of frameAxNodes) byId.set(axNode.nodeId, axNode);
    const parentOf = new Map();
    for (const axNode of frameAxNodes) {
      for (const childId of axNode.childIds || [])
        parentOf.set(childId, axNode.nodeId);
    }
    const rootAx =
      frameAxNodes.find((n) => axString(n.role) === "RootWebArea") ||
      frameAxNodes.find((n) => !parentOf.has(n.nodeId));
    if (!rootAx) continue;
    const grafted = [];
    for (const childId of rootAx.childIds || []) {
      const child = byId.get(childId);
      if (child) grafted.push(...convert(child, byId, false));
    }
    // Tag the grafted subtree so refs bind to this frame's document.
    // Anchor hrefs resolve via the page session in the main flow (same DOM
    // agent), so no per-frame session bookkeeping is needed here.
    walk(grafted, (n) => {
      n.frameId = frameId;
    });
    iframeNode.children = grafted;
  }
}

/**
 * Find an AX node by backendDOMNodeId across all in-process frames' AX
 * trees (the main frame's tree is searched by the caller first). Returns
 * matches as [{ node, byId, frameId }]; more than one match means the id is
 * ambiguous across frames.
 */
async function findAxNodeAcrossFrames(transport, sessionId, backendNodeId) {
  let frameTree;
  try {
    const ft = await transport.call("Page.getFrameTree", {}, sessionId);
    frameTree = (ft && (ft.frameTree || ft.result?.frameTree)) || null;
  } catch {
    return [];
  }
  const frames = [];
  const collect = (node) => {
    if (node && node.frame && typeof node.frame.id === "string") {
      frames.push(node.frame.id);
    }
    for (const child of (node && node.childFrames) || []) collect(child);
  };
  if (frameTree) collect(frameTree);
  // Skip the main frame (index 0): the caller already searched it.
  const matches = [];
  for (const frameId of frames.slice(1)) {
    let axResult;
    try {
      axResult = await transport.call(
        "Accessibility.getFullAXTree",
        { frameId },
        sessionId,
      );
    } catch {
      continue;
    }
    const nodes = (axResult && axResult.nodes) || [];
    const node = nodes.find((n) => n.backendDOMNodeId === backendNodeId);
    if (node) {
      const byId = new Map();
      for (const n of nodes) byId.set(n.nodeId, n);
      matches.push({ node, byId, frameId });
    }
  }
  return matches;
}

/**
 * Keep only nodes in `keepBackendIds` (or matching `predicate`), plus their
 * ancestors. Pass keepBackendIds=null to filter purely by predicate.
 */
function pruneToKeepSet(forest, keepBackendIds, predicate) {
  const survives = (node) => {
    node.children = node.children.filter(survives);
    if (node.role === "root") return true;
    const selfHit = predicate
      ? predicate(node)
      : typeof node.backendNodeId === "number" &&
        keepBackendIds.has(node.backendNodeId);
    return selfHit || node.children.length > 0;
  };
  for (let i = forest.length - 1; i >= 0; i--) {
    if (!survives(forest[i])) forest.splice(i, 1);
  }
}

/**
 * Compute the set of backendNodeIds whose layout boxes intersect the visual
 * viewport (main frame). Returns null when bounds are unavailable, in which
 * case the caller keeps the full tree.
 */
async function viewportKeepSet(transport, sessionId, axNodes) {
  try {
    const [metrics, snapshot] = await Promise.all([
      transport.call("Page.getLayoutMetrics", {}, sessionId),
      transport.call(
        "DOMSnapshot.captureSnapshot",
        { computedStyles: [], includeDOMRects: false },
        sessionId,
      ),
    ]);
    const viewport =
      metrics.cssVisualViewport || metrics.layoutViewport || {};
    const vx = viewport.pageX || 0;
    const vy = viewport.pageY || 0;
    const vw = viewport.clientWidth || 0;
    const vh = viewport.clientHeight || 0;
    if (!vw || !vh) return null;
    const doc = (snapshot.documents || [])[0];
    if (!doc) return null;
    const backendIds = (doc.nodes && doc.nodes.backendNodeId) || [];
    // DOMSnapshot's layout is a single LayoutTreeSnapshot object (not an
    // array); treating it as an array silently disabled viewport filtering.
    const layout = doc.layout || null;
    if (!layout || !Array.isArray(layout.bounds)) return null;
    const bounds = layout.bounds || [];
    const keep = new Set();
    const nodeIndex = layout.nodeIndex || [];
    for (let i = 0; i < nodeIndex.length; i++) {
      // bounds is an array of [x, y, width, height] tuples (not flat).
      const [x, y, w, h] = bounds[i] || [];
      if (typeof x !== "number" || (w === 0 && h === 0)) continue;
      const intersects =
        x < vx + vw && x + w > vx && y < vy + vh && y + h > vy;
      if (intersects) {
        const backendNodeId = backendIds[nodeIndex[i]];
        if (typeof backendNodeId === "number") keep.add(backendNodeId);
      }
    }
    // Structural nodes without layout entries stay undecided; they survive
    // only through kept descendants in pruneToKeepSet.
    return keep;
  } catch {
    return null;
  }
}

async function resolveAnchorUrl(transport, sessionId, backendNodeId) {
  const resolved = await transport.call(
    "DOM.resolveNode",
    { backendNodeId },
    sessionId,
  );
  const objectId = resolved.object && resolved.object.objectId;
  if (!objectId) return undefined;
  try {
    const result = await transport.call(
      "Runtime.callFunctionOn",
      {
        objectId,
        functionDeclaration: "function () { return this.href || undefined; }",
        returnByValue: true,
      },
      sessionId,
    );
    const value = result.result && result.result.value;
    return typeof value === "string" && value ? value : undefined;
  } finally {
    await transport
      .call("Runtime.releaseObject", { objectId }, sessionId)
      .catch(() => {});
  }
}

/**
 * Raw href attribute (unresolved, e.g. "/path?x=1") for loc=href: generation.
 * The native snapshot prints loc=href: with the attribute form while url=
 * carries the resolved absolute URL.
 */
async function resolveAnchorRawHref(transport, sessionId, backendNodeId) {
  const resolved = await transport.call(
    "DOM.resolveNode",
    { backendNodeId },
    sessionId,
  );
  const objectId = resolved.object && resolved.object.objectId;
  if (!objectId) return undefined;
  try {
    const result = await transport.call(
      "Runtime.callFunctionOn",
      {
        objectId,
        functionDeclaration:
          "function () { return this.getAttribute('href') || undefined; }",
        returnByValue: true,
      },
      sessionId,
    );
    const value = result.result && result.result.value;
    return typeof value === "string" && value ? value : undefined;
  } finally {
    await transport
      .call("Runtime.releaseObject", { objectId }, sessionId)
      .catch(() => {});
  }
}

function snapshotError(message, errorCode, isTypeError = false) {
  const error = isTypeError ? new TypeError(message) : new Error(message);
  error.error_code = errorCode;
  return error;
}
