import { Component, StrictMode, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { createConversationShell } from "../conversation-shell.js";
import { ConversationApp } from "./components/conversation";
import "./styles/shell.css";
import "./styles/conversation.css";

class ToolbarBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[doc-review] Review controls rendering failed", error, info.componentStack);
  }
  render() {
    return this.state.failed
      ? <p role="alert">The review controls could not render. Your document has not been reloaded.</p>
      : this.props.children;
  }
}

const host = document.getElementById("toolbarRoot");
if (!host) throw new Error("The review controls host is missing.");
if (!document.body.dataset.review || !document.body.dataset.entry) {
  host.setAttribute("role", "alert");
  host.textContent = "This link has no durable review identity. Open the target again with the current doc-review CLI.";
} else {
  document.body.classList.add("durable-review");
  const shell = createConversationShell();
  createRoot(host).render(<StrictMode><ToolbarBoundary><ConversationApp shell={shell} /></ToolbarBoundary></StrictMode>);
}
