/** UI policy always describes the visible frame, not a newer on-disk source. */
export function executionPresentation(page, rendered, { loading = false, pendingReload = false, error = null } = {}) {
  const eligible = page?.kind === "file" && !page.markdown;
  const policy = rendered?.savePolicy;
  return {
    eligible,
    preference: page?.executionPreference || "auto",
    editDescription: policy === "writable" ? "Edits save directly to this file"
      : policy === "feedback-only" ? "Edits are feedback for the agent to apply"
        : "Waiting for the page's editing policy",
    status: error || (pendingReload ? "Showing the previous page while reload is pending."
      : loading ? "Loading page…" : ""),
    detail: [
      rendered?.executionNotice,
      rendered?.executionMode === "static" && policy === "feedback-only" && eligible
        ? "Scripts are disabled for recovery. Edits still go to the agent; the source is not overwritten." : null,
    ].filter(Boolean).join(" "),
  };
}

export function createExecutionControls({ api, sessionId, elements, changed, failed }) {
  let busy = false;
  let currentPage = null;
  async function recover(preference) {
    if (busy || !currentPage) return;
    const key = currentPage.key;
    busy = true;
    if (elements.menu) {
      elements.menu.open = false;
      elements.menu.querySelector("summary")?.focus({ preventScroll: true });
    }
    elements.static.disabled = elements.auto.disabled = true;
    try {
      const result = await api(`/api/session/${sessionId}/execution`, {
        method: "POST", body: JSON.stringify({ key, preference }),
      });
      if (currentPage?.key === key) changed(result.page);
      // The server's reload event owns draft-safe frame replacement.
    } catch (error) { failed(error); }
    finally {
      busy = false;
      elements.static.disabled = elements.auto.disabled = false;
    }
  }
  elements.static.addEventListener("click", () => void recover("static"));
  elements.auto.addEventListener("click", () => void recover("auto"));
  return {
    render(page, rendered, options) {
      currentPage = page;
      const view = executionPresentation(page, rendered, options);
      elements.static.hidden = !view.eligible || view.preference === "static";
      elements.auto.hidden = !view.eligible || view.preference !== "static";
      if (elements.menu) elements.menu.hidden = !view.eligible && !view.detail;
      elements.status.textContent = view.status;
      elements.status.hidden = !view.status;
      if (elements.details) {
        elements.details.textContent = view.detail;
        elements.details.hidden = !view.detail;
      }
      if (elements.editDescription) elements.editDescription.textContent = view.editDescription;
    },
  };
}
