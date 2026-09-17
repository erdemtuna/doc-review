import { createControllerStore } from "./controller-store.js";

export interface ComposerDraft {
  text: string;
  selectionStart: number;
  selectionEnd: number;
  composing: boolean;
  error: string;
  retry: boolean;
}
export function createComposerDraft(): ComposerDraft {
  return { text: "", selectionStart: 0, selectionEnd: 0, composing: false, error: "", retry: false };
}
export interface ContextualContext {
  open: boolean;
  disabled: boolean;
  submitting: boolean;
  kind: string;
  quote: string;
  placement: string;
  draft: ComposerDraft;
}
interface Options {
  read(): ContextualContext;
  submit(): unknown;
  cancel(): unknown;
  reveal(): void;
  focus(): void;
  measure(): void;
}
export function createContextualController(options: Options) {
  let disposed = false;
  const store = createControllerStore(options.read);
  const available = () => !disposed && options.read().open && !options.read().disabled;
  return {
    getSnapshot: store.getSnapshot, subscribe: store.subscribe, publish: store.publish,
    commands: {
      update(value: Pick<ComposerDraft, "text" | "selectionStart" | "selectionEnd" | "composing">) {
        if (!available() || options.read().submitting) return;
        Object.assign(options.read().draft, value);
        store.publish();
      },
      submit() {
        if (available() && !options.read().draft.composing) return options.submit();
      },
      cancel() { if (available() && !options.read().submitting) return options.cancel(); },
      reveal() { if (available()) options.reveal(); },
      focus() { if (available()) options.focus(); },
      measure() { if (!disposed) options.measure(); },
    },
    dispose() { disposed = true; store.dispose(); },
  };
}
export type ContextualController = ReturnType<typeof createContextualController>;
