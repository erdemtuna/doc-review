const MAX_TABS = 32;
const MAX_ID = 256;
const unknown = (reason) => ({ version: 1, status: "unverified", tabs: [], reason });

export function normalizeView(value) {
  if (value === undefined || value === null) return unknown("View identity was not recorded.");
  const invalid = () => { throw Object.assign(new Error("Invalid captured view identity."), { code: "INVALID_REVISION", status: 400 }); };
  if (value.version !== 1 || !["identified", "unverified"].includes(value.status) ||
      !Array.isArray(value.tabs) || value.tabs.length > MAX_TABS) invalid();
  if (value.status === "unverified") {
    if (value.tabs.length || (value.reason !== undefined && (typeof value.reason !== "string" || value.reason.length > 500))) invalid();
    return unknown(value.reason || "View identity could not be verified.");
  }
  if (!value.tabs.length) invalid();
  const groups = new Set();
  const tabs = value.tabs.map((tab) => {
    if (!tab || typeof tab !== "object") invalid();
    for (const key of ["groupId", "tabId", "panelId", "label"]) {
      if (typeof tab[key] !== "string" || !tab[key] || tab[key].length > MAX_ID) invalid();
    }
    if (groups.has(tab.groupId)) invalid();
    groups.add(tab.groupId);
    return { groupId: tab.groupId, tabId: tab.tabId, panelId: tab.panelId, label: tab.label };
  }).sort((a, b) => a.groupId.localeCompare(b.groupId));
  return { version: 1, status: "identified", tabs };
}

function viewKey(view) {
  const normalized = normalizeView(view);
  return JSON.stringify([normalized.status, normalized.tabs.map(({ groupId, tabId, panelId }) => [groupId, tabId, panelId])]);
}

export function sameObservedView(before, after) {
  return viewKey(before) === viewKey(after);
}

export function compareCapturedViews(before, after) {
  const left = normalizeView(before);
  const right = normalizeView(after);
  if (left.status === "identified") {
    if (right.status === "identified" && sameObservedView(left, right)) {
      return { status: "matched", message: `Matching visible view: ${left.tabs.map((tab) => tab.label).join(" / ")}.` };
    }
    return {
      status: "mismatch",
      message: `Return to ${left.tabs.map((tab) => tab.label).join(" / ")} to capture the result.${right.status === "unverified" ? " The current tab identity could not be verified." : ""}`,
    };
  }
  return { status: "unverified", message: "Visible content only; matching view not verified." };
}

export function observeView(document) {
  const started = Date.now();
  let visited = 0;
  let limited = false;
  const visible = (element) => {
    for (let node = element; node; node = node.parentElement) {
      if (++visited > 5000 || Date.now() - started > 500) {
        limited = true;
        return false;
      }
      if (node.hidden || node.getAttribute("aria-hidden") === "true" || node.hasAttribute("data-eh-ui")) return false;
      const style = document.defaultView.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return false;
    }
    return true;
  };
  const uniqueId = (element) => {
    if (!element?.id || element.id.length > MAX_ID) return false;
    const escaped = element.id.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\n\r\f]/g, "");
    return document.querySelectorAll(`[id="${escaped}"]`).length === 1;
  };
  const candidates = document.querySelectorAll('[role="tablist"]');
  if (candidates.length > MAX_TABS) return unknown("Too many tab groups to identify reliably.");
  const groups = [...candidates].filter(visible);
  if (limited) return unknown("View identity observation exceeded its limits.");
  if (!groups.length) return unknown("No reliably identifiable tab groups were found.");
  if (groups.length > MAX_TABS) return unknown("Too many tab groups to identify reliably.");
  const tabs = [];
  for (const group of groups) {
    const members = [...group.querySelectorAll('[role="tab"]')].filter((tab) => tab.closest('[role="tablist"]') === group);
    if (members.length > 128 || Date.now() - started > 500) return unknown("View identity observation exceeded its limits.");
    const selected = members.filter((tab) => tab.getAttribute("aria-selected") === "true");
    if (selected.length !== 1) return unknown("A tab group does not have exactly one selected tab.");
    const tab = selected[0];
    const panelId = tab.getAttribute("aria-controls");
    const panel = panelId && document.getElementById(panelId);
    if (!visible(tab) || !uniqueId(tab) || !uniqueId(panel) || panel.getAttribute("role") !== "tabpanel" || !visible(panel)) {
      return unknown("Selected tabs and visible panels do not have unique stable identifiers.");
    }
    // A complete set of authored tab IDs identifies an otherwise unnamed tablist.
    if (!members.length || members.some((member) => !uniqueId(member))) return unknown("Tab identifiers are incomplete.");
    const groupId = uniqueId(group) ? `id:${group.id}` : `tabs:${JSON.stringify(members.map((member) => member.id).sort())}`;
    if (groupId.length > MAX_ID) return unknown("Tab group identity exceeds the capture limit.");
    const label = (tab.getAttribute("aria-label") || tab.textContent || tab.id).replace(/\s+/g, " ").trim().slice(0, MAX_ID);
    tabs.push({ groupId, tabId: tab.id, panelId, label: label || tab.id });
  }
  return normalizeView({ version: 1, status: "identified", tabs });
}
