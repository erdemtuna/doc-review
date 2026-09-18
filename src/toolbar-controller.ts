import { createControllerStore } from "./controller-store.js";

export interface ToolbarState {
  comparing: boolean;
  mode: "view" | "edit";
  modeDisabled: boolean;
  modeMenuOpen: boolean;
  restoreModeFocus: boolean;
  editDescription: string;
  drawerOpen: boolean;
  feedbackCount: number;
  theme: "light" | "dark";
  ended: boolean;
}

interface ToolbarCommands {
  setComparing(comparing: boolean): void;
  setMode(mode: "view" | "edit"): void;
  setModeMenu(open: boolean): void;
  openComments(): void;
  toggleTheme(): void;
}

export function createToolbarController(read: () => ToolbarState, commands: ToolbarCommands) {
  const store = createControllerStore(read);
  return {
    ...store,
    commands: {
      setComparing(comparing: boolean) {
        if (!read().ended) commands.setComparing(comparing);
      },
      setMode(mode: "view" | "edit") {
        const state = read();
        if (!state.ended && !state.modeDisabled) commands.setMode(mode);
      },
      setModeMenu(open: boolean) {
        const state = read();
        if (!state.ended && (!open || !state.modeDisabled)) commands.setModeMenu(open);
      },
      openComments() {
        const state = read();
        if (!state.ended && !state.comparing) commands.openComments();
      },
      toggleTheme() {
        if (!read().ended) commands.toggleTheme();
      },
    },
  };
}

export type ToolbarController = ReturnType<typeof createToolbarController>;
