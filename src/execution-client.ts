import type { PageMetadata, RenderExecution } from "./contracts/page.js";

/** UI policy describes the visible frame, not a newer on-disk source. */
export function executionPresentation(
  page: Partial<PageMetadata> | null,
  rendered: Partial<RenderExecution> | null,
  { loading = false, pendingReload = false, error = null }: {
    loading?: boolean; pendingReload?: boolean; error?: string | null;
  } = {},
) {
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
