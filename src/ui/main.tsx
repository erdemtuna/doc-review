import { Component, StrictMode, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import { toolbarRuntime, recoveryRuntime, commentsRuntime, contextualRuntime, feedbackRuntime, changesRuntime } from "../chrome-client.js";
import { Toolbar } from "./components/toolbar";
import { RecoveryMenu, RecoveryNotices } from "./components/recovery";
import { CommentsDrawer } from "./components/comments";
import { Composer, AlignedComment } from "./components/contextual";
import { FeedbackEdits, FeedbackFooter, FeedbackConfirmation } from "./components/feedback";
import { ChangesControls, ChangesNavigation, ChangesDiagnostics, ChangesDetail } from "./components/changes";
import "./styles/shell.css";

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
const notices = document.getElementById("noticesRoot");
const drawer = document.getElementById("drawer");
const drawerHeader = document.getElementById("drawerHeadRoot");
const inventory = document.getElementById("inventoryRoot");
const backdrop = document.getElementById("drawerBackdropRoot");
const compose = document.getElementById("compose");
const aligned = document.getElementById("alignedCard");
const edits = document.getElementById("editsRoot");
const footer = document.getElementById("sendSection");
const changesControls = document.getElementById("changesControlsRoot");
const changesNavigation = document.getElementById("changesNavigationRoot");
const changesDiagnostics = document.getElementById("changesDiagnosticsRoot");
const comparisonRoot = document.getElementById("changeDetail");
const comparisonHeader = document.getElementById("comparisonHeader");
const comparisonHeading = document.querySelector<HTMLElement>(".comparison-heading-slot");
if (!host || !notices || !drawer || !drawerHeader || !inventory || !backdrop || !compose || !aligned || !edits || !footer || !changesControls || !changesNavigation || !changesDiagnostics || !comparisonRoot || !comparisonHeader || !comparisonHeading) throw new Error("The review control hosts are missing");
createRoot(host).render(<StrictMode><ToolbarBoundary>
  <Toolbar runtime={toolbarRuntime} />
  <RecoveryMenu runtime={recoveryRuntime} />
  {createPortal(<RecoveryNotices runtime={recoveryRuntime} />, notices)}
  <CommentsDrawer runtime={commentsRuntime} drawer={drawer} header={drawerHeader} inventory={inventory} backdrop={backdrop} />
  {createPortal(<Composer runtime={contextualRuntime} />, compose)}
  {createPortal(<AlignedComment runtime={commentsRuntime} measure={contextualRuntime.commands.measure} />, aligned)}
  {createPortal(<FeedbackEdits runtime={feedbackRuntime} />, edits)}
  {createPortal(<FeedbackFooter runtime={feedbackRuntime} />, footer)}
  <FeedbackConfirmation runtime={feedbackRuntime} />
  {createPortal(<ChangesControls runtime={changesRuntime} />, changesControls)}
  {createPortal(<ChangesNavigation runtime={changesRuntime} />, changesNavigation)}
  {createPortal(<ChangesDiagnostics runtime={changesRuntime} />, changesDiagnostics)}
  <ChangesDetail runtime={changesRuntime} root={comparisonRoot} headingSlot={comparisonHeading} header={comparisonHeader} />
</ToolbarBoundary></StrictMode>);
