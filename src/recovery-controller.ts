import { createControllerStore } from "./controller-store.js";
import { decodePage, record } from "./chrome-api.js";
import type { ExecutionPreference, FrameRenderState, PageMetadata, PageResponse, RenderExecution } from "./contracts/page.js";
import { executionPresentation } from "./execution-client.js";
import type { ThemeSync } from "./frame-controller.js";

export interface RecoveryContext {
  page: Partial<PageMetadata> | null;
  rendered: Partial<RenderExecution> | null;
  identity: FrameRenderState;
  comparing: boolean;
  ended: boolean;
  loading: boolean;
  pendingReload: boolean;
  frameError: string | null;
  reload: { visible: boolean; message: string; error: boolean };
  themeSync?: ThemeSync;
}

interface Options {
  sessionId: string;
  read(): RecoveryContext;
  request(path: string, options: RequestInit): Promise<unknown>;
  changed(page: PageResponse): void;
  failed(message: string): void;
  menuChanged(open: boolean): void;
  reload(): Promise<void>;
  keepCurrent(): void;
  retryTheme?(): Promise<boolean>;
}

export function createRecoveryController(options: Options) {
  let disposed = false;
  let busy = false;
  let reloadBusy = false;
  let menuOpen = false;
  let restoreMenuFocus = true;
  let failure: { identity: FrameRenderState; message: string } | null = null;
  const lifetime = new AbortController();
  const matches = (a: FrameRenderState, b: FrameRenderState) =>
    a.key === b.key && a.generation === b.generation && a.renderId === b.renderId;
  function project() {
    const context = options.read();
    const view = executionPresentation(context.page, context.rendered, {
      loading: context.loading, pendingReload: context.pendingReload, error: context.frameError,
    });
    const visible = !context.ended && !context.comparing;
    const menuVisible = visible && (view.eligible || !!view.detail);
    const error = failure && matches(failure.identity, context.identity) ? failure.message : null;
    return {
      menuVisible, menuOpen: menuVisible && menuOpen, restoreMenuFocus,
      busy, canRecover: !disposed && !context.ended && !context.comparing && !busy && view.eligible && !!context.identity.key,
      preference: view.preference, eligible: view.eligible, detail: view.detail,
      reloadVisible: visible && context.reload.visible,
      reloadMessage: context.reload.message, reloadError: context.reload.error,
      canReload: !disposed && visible && context.reload.visible && !!context.identity.key && (!context.loading || !!context.frameError) && !reloadBusy,
      reloadBusy,
      themeVisible: visible && context.themeSync?.status === "failed",
      themeMessage: context.themeSync?.message || "",
      canRetryTheme: !disposed && visible && context.themeSync?.status === "failed" && !!options.retryTheme,
      status: visible && !context.reload.visible ? (context.frameError || error || view.status || (busy ? "Updating page recovery settings…" : "")) : "",
      statusError: !!context.frameError || !!error,
    };
  }
  const store = createControllerStore(project);
  function setMenuOpen(open: boolean, { restoreFocus = true } = {}) {
    if (disposed || (open && !project().menuVisible)) return;
    if (menuOpen === open) {
      // The iframe's interaction message can arrive after native dismissal.
      if (!open && !restoreFocus) {
        restoreMenuFocus = false;
        store.publish();
      }
      return;
    }
    menuOpen = open;
    restoreMenuFocus = restoreFocus;
    store.publish();
    options.menuChanged(open);
  }
  function publish() {
    if (!project().menuVisible) setMenuOpen(false, { restoreFocus: false });
    return store.publish();
  }
  async function recover(preference: ExecutionPreference) {
    if (!project().canRecover) return;
    const identity = { ...options.read().identity };
    busy = true;
    failure = null;
    setMenuOpen(false);
    publish();
    try {
      const response = record(await options.request(`/api/session/${options.sessionId}/execution`, {
        method: "POST", body: JSON.stringify({ key: identity.key, preference }), signal: lifetime.signal,
      }));
      const page = decodePage(response.page);
      if (!disposed && matches(identity, options.read().identity)) {
        if (page.key !== identity.key) throw new Error("The recovery response belongs to a different page.");
        options.changed(page);
      }
      // The server event remains the only owner of draft-safe frame replacement.
    } catch (error) {
      if (!disposed && matches(identity, options.read().identity)) {
        const message = error instanceof Error ? error.message : String(error);
        failure = { identity, message: `Recovery could not be updated: ${message}. Retry from More.` };
        options.failed(message);
      }
    } finally {
      busy = false;
      publish();
    }
  }
  async function reload() {
    if (!project().canReload) return;
    reloadBusy = true;
    publish();
    try { await options.reload(); }
    catch (error) {
      if (!disposed) options.failed(error instanceof Error ? error.message : String(error));
    } finally { reloadBusy = false; publish(); }
  }
  return {
    getSnapshot: store.getSnapshot, subscribe: store.subscribe, publish,
    commands: {
      setMenuOpen, recover, reload,
      async retryTheme() {
        if (!project().canRetryTheme) return;
        await options.retryTheme?.();
        publish();
      },
      keepCurrent() {
        if (disposed || !project().reloadVisible || reloadBusy) return;
        options.keepCurrent();
        publish();
      },
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      lifetime.abort();
      store.dispose();
    },
  };
}

export type RecoveryController = ReturnType<typeof createRecoveryController>;
