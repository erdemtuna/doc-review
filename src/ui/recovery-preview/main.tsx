import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { createRecoveryController, type RecoveryContext } from "../../recovery-controller.js";
import type { PageResponse } from "../../contracts/page.js";
import { RecoveryMenu, RecoveryNotices } from "../components/recovery";
import { Button } from "../components/ui/button";
import { NativeSelect, NativeSelectOption } from "../components/ui/native-select";
import "../styles/shell.css";
import "./preview.css";

const scenarios = ["Ready", "Loading", "Source updated", "Save conflict", "Frame failed", "Request failed"] as const;
type Scenario = typeof scenarios[number];
const page: PageResponse = {
  key: "preview", kind: "file", file: "preview.html", filename: "preview.html", markdown: false,
  executionPreference: "auto", executionMode: "interactive", savePolicy: "feedback-only",
  feedbackOnly: true, canRevert: true, pollCommand: "", historySupported: true, comments: [], edits: [],
};
const context: RecoveryContext = {
  page, rendered: page, identity: { key: "preview", renderId: "preview", generation: 1, loading: false },
  comparing: false, ended: false, loading: false, pendingReload: false, frameError: null,
  reload: { visible: false, message: "", error: false },
};
let scenario: Scenario = "Ready";
const runtime = createRecoveryController({
  sessionId: "preview", read: () => context,
  async request(_path, options) {
    if (scenario === "Request failed") throw new Error("Preview service unavailable");
    const preference: unknown = JSON.parse(String(options.body)).preference;
    if (preference !== "auto" && preference !== "static") throw new Error("Invalid preview preference");
    return { page: { ...page, executionPreference: preference } };
  },
  changed(value) { context.page = value; show("Source updated"); },
  failed(message) { console.info("[recovery-preview] Simulated failure:", message); },
  menuChanged() {},
  async reload() { show("Ready"); },
  keepCurrent() { context.reload.visible = false; },
});
function show(next: Scenario) {
  scenario = next;
  context.loading = next === "Loading" || next === "Frame failed";
  context.frameError = next === "Frame failed" ? "The page could not finish loading. Retry when it is available." : null;
  context.pendingReload = next === "Source updated" || next === "Save conflict";
  context.reload = {
    visible: context.pendingReload || next === "Frame failed",
    error: next === "Save conflict" || next === "Frame failed",
    message: next === "Save conflict"
      ? "The source changed while you had unsaved edits. Reload latest to continue; comment drafts stay in this review."
      : next === "Frame failed"
        ? "The latest page did not become ready. Reload latest to retry; comment drafts stay in this review."
        : "The source changed while you had a comment draft. Reload latest when you are ready; comment drafts stay in this review.",
  };
  context.identity = { ...context.identity, generation: context.identity.generation + 1 };
  runtime.commands.setMenuOpen(false, { restoreFocus: false });
  runtime.publish();
  if (next === "Request failed") void runtime.commands.recover("static");
}

function Preview() {
  const [theme, setTheme] = useState("light");
  const [selected, setSelected] = useState<Scenario>("Source updated");
  return <main className="recovery-preview">
    <section className="preview-controls">
      <h1>G3 / More and recovery notices</h1>
      <p>Component-state fixture, not a live review. These are the production components with simulated
        state and sample copy. Actions affect this preview only; use the separate shell preview for real reloads.</p>
      <div className="preview-options">
        <label htmlFor="scenario">Preview state</label>
        <NativeSelect id="scenario" value={selected} onChange={(event) => {
          const next = scenarios.find((value) => value === event.target.value);
          if (!next) throw new Error("Unknown preview state");
          setSelected(next);
          show(next);
        }}>
          {scenarios.map((value) => <NativeSelectOption key={value}>{value}</NativeSelectOption>)}
        </NativeSelect>
        <Button variant="outline" onClick={() => {
          const next = theme === "light" ? "dark" : "light";
          document.documentElement.dataset.theme = next;
          setTheme(next);
        }}>Switch to {theme === "light" ? "dark" : "light"}</Button>
        <Button variant="ghost" onClick={() => show(selected)}>Reset state</Button>
      </div>
    </section>
    <section className="preview-surface" aria-label="Recovery component preview">
      <header className="preview-toolbar"><span>Review / sample document</span><RecoveryMenu runtime={runtime} /></header>
      <div id="noticesRoot" className="review-ui"><RecoveryNotices runtime={runtime} /></div>
      <article className="preview-document">
        <h2>The document keeps its space</h2>
        <p>Notices sit above the document rather than covering its first lines. Longer notices wrap,
          with a bounded scrollable area at smaller screen sizes.</p>
        <label htmlFor="sample-draft">Sample page draft</label>
        <input id="sample-draft" defaultValue="Keep this text while inspecting the controls" />
        <p>Try More with the keyboard, Escape, theme switching, and narrow widths. This page is an
          inert example; it does not simulate the authored iframe or saving.</p>
      </article>
    </section>
  </main>;
}

show("Source updated");
const root = document.getElementById("root");
if (!root) throw new Error("Recovery preview root is missing");
createRoot(root).render(<StrictMode><Preview /></StrictMode>);
