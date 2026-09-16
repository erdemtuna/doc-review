export function createDocumentTrustControls({ api, sessionId, container, onChanged = () => {}, onError = () => {} }) {
  const document = container.ownerDocument;
  container.classList.add("document-trust");
  container.hidden = true;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "script-switch";
  button.setAttribute("role", "switch");
  button.setAttribute("aria-label", "Enable page scripts");
  button.setAttribute("aria-checked", "false");
  button.setAttribute("aria-describedby", "scriptHelp scriptStatus scriptError");
  const label = document.createElement("span");
  label.className = "script-switch-label";
  label.textContent = "Enable page scripts";
  const shortLabel = document.createElement("span");
  shortLabel.className = "script-switch-short-label";
  shortLabel.textContent = "Scripts";
  shortLabel.setAttribute("aria-hidden", "true");
  const value = document.createElement("span");
  value.className = "script-switch-value";
  value.setAttribute("aria-hidden", "true");
  const track = document.createElement("span");
  track.className = "script-switch-track";
  track.setAttribute("aria-hidden", "true");
  button.append(label, shortLabel, value, track);

  const help = document.createElement("p");
  help.id = "scriptHelp";
  help.className = "script-help";
  help.textContent = "Runs this file's scripts; edits are sent as feedback.";
  const status = document.createElement("p");
  status.id = "scriptStatus";
  status.className = "script-status";
  status.setAttribute("role", "status");
  const error = document.createElement("p");
  error.id = "scriptError";
  error.className = "script-error";
  error.setAttribute("role", "alert");
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "script-retry";
  retry.textContent = "Check again";
  const details = document.createElement("details");
  details.className = "script-details";
  const summary = document.createElement("summary");
  summary.textContent = "?";
  summary.setAttribute("aria-label", "Script details");
  const detailBody = document.createElement("div");
  detailBody.className = "script-details-body";
  const explanation = document.createElement("p");
  explanation.textContent = "Enable only files whose JavaScript you trust. Permission applies to this exact saved version. Changed files need approval again. Turning scripts off requires a reload; open comment drafts are preserved.";
  const boundary = document.createElement("p");
  detailBody.append(help, explanation, boundary, status, error, retry);
  details.append(summary, detailBody);
  const announcement = document.createElement("span");
  announcement.className = "sr-only";
  announcement.setAttribute("role", "status");
  container.append(button, details, announcement);

  let currentPage = null;
  let currentTrust = null;
  let revision = 0;
  let operation = null;
  let checking = false;
  let renderState = {};
  const sources = new Map();
  const changedSources = new Set();
  const url = `/api/session/${sessionId}/trust`;

  function render() {
    const approved = currentTrust?.approved === true;
    button.setAttribute("aria-checked", String(approved));
    button.setAttribute("aria-disabled", String(checking || !!operation || !currentTrust?.sourceHash || !!currentTrust.unavailable));
    button.setAttribute("aria-busy", String(checking || !!operation));
    value.textContent = currentTrust ? (approved ? "On" : "Off") : "-";
    const pending = renderState.pendingReload || (currentTrust && !renderState.loading
      && typeof renderState.trustedInteractive === "boolean" && approved !== renderState.trustedInteractive);
    const messages = [];
    if (operation && !pending) messages.push(operation.action === "grant" ? "Enabling scripts..." : "Disabling scripts...");
    else if (checking && !currentTrust && !pending) messages.push("Checking script permission...");
    if (!approved && changedSources.has(currentPage?.key)) messages.push("File changed - enable again.");
    if (renderState.error) {
      messages.push(renderState.error);
    } else if (pending) {
      messages.push(renderState.trustedInteractive === undefined
        ? "Reload pending. The displayed page's script state is unconfirmed."
        : renderState.trustedInteractive
        ? "Reload pending. Scripts in the displayed version are still running."
        : "Reload pending. Scripts are still blocked in the displayed version.");
    } else if (renderState.loading && !checking) {
      messages.push("Applying page settings...");
    }
    if (currentTrust?.unavailable) messages.push(currentTrust.unavailable);
    status.textContent = messages.join(" ");
    status.hidden = !status.textContent;
    error.hidden = !error.textContent;
    if (error.textContent) status.hidden = true;
    boundary.textContent = renderState.notice || "Self-contained scripts only. External scripts, workers, and embedded apps remain blocked; use localhost for applications that need them. Edits are sent as feedback, not saved over the file.";
    const feedback = error.textContent || status.textContent;
    if (announcement.textContent !== feedback) announcement.textContent = feedback;
    summary.textContent = checking || operation ? "..." : feedback ? "!" : "?";
    summary.title = feedback || "About page scripts";
    button.title = help.textContent;
    retry.hidden = !error.textContent && !currentTrust?.unavailable;
    retry.disabled = checking || !!operation;
  }

  function acceptTrust(trust) {
    const key = currentPage.key;
    const previous = sources.get(key);
    if (previous && previous !== trust.sourceHash) changedSources.add(key);
    if (trust.approved) changedSources.delete(key);
    sources.set(key, trust.sourceHash);
    currentTrust = trust;
  }

  async function refresh(page = currentPage, { keepError = false } = {}) {
    if (page?.key !== currentPage?.key) {
      operation = null;
      currentTrust = null;
      renderState = {};
    }
    currentPage = page;
    container.hidden = !(page?.kind === "file" && !page.markdown);
    if (operation) return;
    const turn = ++revision;
    if (container.hidden) currentTrust = null;
    checking = !container.hidden;
    if (!keepError) error.textContent = "";
    render();
    if (container.hidden) return;
    try {
      const result = await api(url);
      if (turn !== revision) return;
      acceptTrust(result.trust);
    } catch (reason) {
      if (turn !== revision) return;
      currentTrust = null;
      error.textContent = `Could not check script permission. ${reason.message}`;
      onError(reason);
    } finally {
      if (turn === revision) {
        checking = false;
        render();
      }
    }
  }

  async function change() {
    if (button.getAttribute("aria-disabled") === "true") return;
    const request = {
      action: currentTrust.approved ? "revoke" : "grant",
      sourceHash: currentTrust.sourceHash,
      key: currentPage.key,
    };
    operation = request;
    ++revision;
    error.textContent = "";
    render();
    try {
      const result = await api(url, { method: "POST", body: JSON.stringify(request) });
      if (operation !== request) return;
      acceptTrust(result.trust);
      onChanged(result.page);
    } catch (reason) {
      if (operation !== request) return;
      error.textContent = `Could not change script permission. ${reason.message}`;
      onError(reason);
    } finally {
      if (operation === request) {
        operation = null;
        // Reconcile even failed writes: the server may have accepted a request
        // whose response was lost. Never retry an approval automatically.
        await refresh(currentPage, { keepError: true });
      }
    }
  }

  button.addEventListener("click", () => void change());
  retry.addEventListener("click", () => void refresh());
  container.addEventListener("keydown", (event) => {
    if (event.key === "Escape") event.stopPropagation();
  });
  details.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    details.open = false;
    summary.focus();
    event.stopPropagation();
  });
  document.addEventListener("pointerdown", (event) => {
    if (!details.contains(event.target)) details.open = false;
  });
  return {
    refresh,
    setRenderState(next) {
      renderState = next;
      render();
    },
  };
}
