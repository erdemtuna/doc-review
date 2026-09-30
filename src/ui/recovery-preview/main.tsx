import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { ReceiptRecovery, RecoveryNotice } from "../components/recovery-notice";
import { Button } from "../components/ui/button";
import { NativeSelect, NativeSelectOption } from "../components/ui/native-select";
import "../styles/shell.css";
import "../styles/conversation.css";
import "./preview.css";

const scenarios = ["Acceptance unknown", "Source conflict", "Disconnected", "Theme failed", "Busy"] as const;
type Scenario = typeof scenarios[number];

function Preview() {
  const [theme, setTheme] = useState("light");
  const [selected, setSelected] = useState<Scenario>("Acceptance unknown");
  const [action, setAction] = useState("");
  const sample = (label: string) => () => setAction(`Preview only: ${label}. No request was sent.`);
  return <main className="recovery-preview">
    <section className="preview-controls">
      <h1>Current recovery presentation</h1>
      <p>Shared production notices with synthetic state, not a simulated review controller.
        Use preview:shell for real requests, reloads and receipt reconciliation.</p>
      <div className="preview-options">
        <label htmlFor="scenario">Preview fixture (native tooling field)</label>
        <NativeSelect id="scenario" value={selected} onChange={event => {
          const next = scenarios.find(value => value === event.target.value);
          if (!next) throw new Error("Unknown preview state");
          setSelected(next); setAction("");
        }}>{scenarios.map(value => <NativeSelectOption key={value}>{value}</NativeSelectOption>)}</NativeSelect>
        <Button variant="outline" onClick={() => {
          const next = theme === "light" ? "dark" : "light";
          document.documentElement.dataset.theme = next; setTheme(next);
        }}>Switch to {theme === "light" ? "dark" : "light"}</Button>
      </div>
    </section>
    <section className="preview-surface review-ui" aria-label="Recovery component preview">
      {(selected === "Acceptance unknown" || selected === "Busy") && <ReceiptRecovery
        uncertain={{ operation: "send", requestId: "synthetic-request-id", message: "Acceptance is unknown. Check the receipt before repeating any source work." }}
        busy={selected === "Busy"} onCheck={sample("Check receipt")} onRetry={sample("Retry same request")} onRefresh={sample("Refresh review")} />}
      {selected === "Source conflict" && <RecoveryNotice messages={["Source changed. Inspect the source before reloading; conversation drafts are retained."]}
        actions={<><Button size="sm" variant="outline" onClick={sample("Refresh review")}>Refresh review</Button>
          <Button size="sm" variant="destructive" onClick={sample("Reload source")}>Reload source (discard local page edits)</Button></>} />}
      {selected === "Disconnected" && <RecoveryNotice tone="warning" title="Connection lost"
        messages={["Showing previously loaded information."]} actions={<Button size="sm" variant="outline" onClick={sample("Reconnect")}>Reconnect</Button>}>
        <details><summary>Connection details</summary>The synthetic event stream is unavailable.</details>
      </RecoveryNotice>}
      {selected === "Theme failed" && <RecoveryNotice messages={["Annotation theme synchronization was not confirmed. Your page and drafts are unchanged."]}
        actions={<Button size="sm" variant="outline" onClick={sample("Retry theme")}>Retry theme</Button>} />}
      <p role="status">{action}</p>
      <article className="preview-document">
        <h2>Retained draft specimen</h2>
        <label htmlFor="sample-draft">Sample page draft</label>
        <input id="sample-draft" defaultValue="Keep this text while inspecting the controls" />
        <p>Inspect both themes, narrow widths, keyboard focus, disabled actions and long notice wrapping.</p>
      </article>
    </section>
  </main>;
}

const root = document.getElementById("root");
if (!root) throw new Error("Recovery preview root is missing");
createRoot(root).render(<StrictMode><Preview /></StrictMode>);
