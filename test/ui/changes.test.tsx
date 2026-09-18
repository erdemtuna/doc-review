import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createChangesController, type ChangesContext } from "../../src/changes-controller";
import { ChangesControls, ChangesToolbar, ChangesDiagnostics, ChangesDetail } from "@/components/changes";

afterEach(cleanup);
function fixture() {
  const context: ChangesContext = {
    ended: false, comparing: true, sending: false,
    current: { key: "page", kind: "file", ready: true, pendingReload: false, dirty: false, sourceHash: "h", sessionId: "s", generation: 1 },
    history: {
      rounds: [{ roundId: "round", ordinal: 1 }], selectedId: "round", targetKey: "page",
      round: { roundId: "round", feedbackStatus: "acknowledged", targets: [
        { key: "page", filename: "file.html", capture: { status: "failed" }, comparison: {
          content: { available: true, limitations: ["visible_only"], changes: [{ label: "one" }, { label: "two" }], counts: { added: 0, modified: 2, removed: 0 } },
          source: { available: true, changes: [{ label: "source one" }, { label: "source two" }] },
        } },
        { key: "other", filename: "other.html" },
      ] },
      preferredMode: null, index: 0, loading: false, error: null, captureBusy: false, finalizing: false, failures: new Map(),
    },
  };
  const capture = vi.fn();
  const runtime = createChangesController({
    read: () => context, selectRound: vi.fn(), selectTarget: vi.fn(),
    selectMode: (mode) => { context.history.preferredMode = mode; context.history.index = 0; runtime.publish(); },
    selectIndex: (index) => { context.history.index = index; runtime.publish(); },
    capture, finish: vi.fn(), refresh: vi.fn(), failed: vi.fn(),
  });
  render(<StrictMode><ChangesControls runtime={runtime}/><ChangesToolbar runtime={runtime}/><ChangesDiagnostics runtime={runtime}/></StrictMode>);
  return { context, runtime, capture };
}
it("keeps choice trigger and format button identity through publications and format selection", () => {
  const { context, runtime } = fixture();
  const round = screen.getByRole("button", { name: /^Review round:/ });
  const source = screen.getByRole("button", { name: "Source" });
  fireEvent.click(source);
  expect(source).toHaveAttribute("aria-pressed", "true");
  act(() => { context.history.loading = true; runtime.publish(); });
  expect(screen.getByRole("button", { name: /^Review round:/ })).toBe(round);
  expect(screen.getByRole("button", { name: "Source" })).toBe(source);
  expect(source).toBeDisabled();
});
it("normalizes navigation and exposes counts and meaningful labels", () => {
  fixture();
  expect(screen.getByRole("img", { name: "2 modified changes" })).toHaveAttribute("title", "Modified changes");
  expect(screen.getByRole("button", { name: "Previous change" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Next change" }));
  expect(screen.getByText("2 of 2")).toBeVisible();
  expect(screen.getByRole("button", { name: "Next change" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Jump to change: 2 of 2" })).toHaveAttribute("data-value", "1");
});
it("groups context, display, navigation and ready status in one toolbar without duplicate controls", () => {
  fixture();
  const toolbar = screen.getByRole("group", { name: "Comparison tools" });
  expect(within(toolbar).getByRole("group", { name: "Comparison format" })).toBeVisible();
  expect(within(toolbar).getByRole("img", { name: "2 modified changes" })).toBeVisible();
  expect(within(toolbar).getByRole("navigation", { name: "Change navigation" })).toBeVisible();
  expect(within(toolbar).getByRole("button", { name: /^Jump to change:/ })).toBeVisible();
  for (const label of ["Review round", "Comparison page"]) {
    expect(screen.getAllByRole("button", { name: new RegExp(`^${label}:`) })).toHaveLength(1);
    expect(within(toolbar).getByRole("button", { name: new RegExp(`^${label}:`) })).toBeVisible();
  }
  expect(within(toolbar).getByRole("status")).toHaveTextContent("Comparison ready.");
  expect(within(toolbar).getByRole("status")).toHaveClass("sr-only");
  expect(screen.getAllByRole("status")).toHaveLength(1);
  expect(within(toolbar).queryByRole("button", { name: "Capture result" })).toBeNull();
  expect(screen.getAllByRole("button", { name: "Source" })).toHaveLength(1);
});
it.each([0, 1])("keeps an available %i-change comparison visible without empty navigation", (count) => {
  const { context, runtime } = fixture();
  act(() => {
    context.history.round = { roundId: "round", targets: [{ key: "page", resultRevisionId: "result", comparison: {
      source: { available: true, changes: Array.from({ length: count }, () => ({ label: "change" })),
        counts: { added: count, modified: 0, removed: 0 } },
    } }] };
    runtime.publish();
  });
  const toolbar = screen.getByRole("group", { name: "Comparison tools" });
  expect(toolbar).toBeVisible();
  expect(within(toolbar).getByRole("button", { name: "Source" })).toHaveAttribute("aria-pressed", "true");
  expect(within(toolbar).getByRole("img", { name: `${count} added changes` })).toBeVisible();
  expect(within(toolbar).getByRole("img", { name: "0 modified changes" })).toBeVisible();
  expect(within(toolbar).getByRole("img", { name: "0 removed changes" })).toBeVisible();
  expect(within(toolbar).queryByRole("navigation")).toBeNull();
  expect(screen.queryByRole("button", { name: /^Comparison page:/ })).toBeNull();
});
it("leaves Round and recovery accessible when no representation can show comparison tools", () => {
  const { context, runtime } = fixture();
  act(() => {
    context.history.round!.targets![0].comparison = {};
    context.history.error = { message: "History temporarily offline" };
    runtime.publish();
  });
  expect(screen.getByRole("button", { name: /^Review round:/ })).toBeEnabled();
  expect(screen.queryByRole("group", { name: "Comparison format" })).toBeNull();
  expect(screen.getByRole("status")).toHaveTextContent("Content capture failed.");
  expect(screen.getByRole("status")).not.toHaveClass("sr-only");
  expect(screen.getByRole("button", { name: "Capture result" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Retry history" })).toBeEnabled();
  expect(screen.getByRole("alert")).toHaveTextContent("History temporarily offline");
  expect(screen.getAllByRole("status")).toHaveLength(1);
});
it("closes menus on changed context or leaving Changes while unrelated updates retain the open menu", async () => {
  const { context, runtime } = fixture();
  const user = userEvent.setup();
  const page = screen.getByRole("button", { name: /^Comparison page:/ });
  await user.click(page);
  expect(screen.getByRole("menu")).toBeVisible();
  act(() => { context.current.dirty = true; runtime.publish(); });
  expect(screen.getByRole("menu")).toBeVisible();
  act(() => { context.history.preferredMode = "source"; runtime.publish(); });
  expect(screen.queryByRole("menu")).toBeNull();
  await user.click(page);
  act(() => { context.comparing = false; runtime.publish(); });
  expect(screen.queryByRole("menu")).toBeNull();
  expect(page).toBeDisabled();
});
it("uses checked menu choices for Jump and exposes an icon legend without extra count tab stops", async () => {
  const { runtime } = fixture();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /^Jump to change:/ }));
  expect(screen.getByRole("menuitemradio", { name: /1\./ })).toHaveAttribute("aria-checked", "true");
  await user.click(screen.getByRole("menuitemradio", { name: /2\./ }));
  expect(screen.queryByRole("menu")).toBeNull();
  expect(screen.getByRole("button", { name: "Jump to change: 2 of 2" })).toHaveFocus();
  for (const count of screen.getAllByRole("img")) expect(count).not.toHaveAttribute("tabindex");
  act(() => runtime.commands.disclose("diagnostics", true));
  expect(screen.getByText("Added")).toBeVisible();
  expect(screen.getByText("Modified")).toBeVisible();
  expect(screen.getByText("Removed")).toBeVisible();
});
it("retains owned diagnostics while unavailable Source remains distinct from Content", () => {
  const { context, runtime } = fixture();
  const details = screen.getByText("Comparison details").closest("details")!;
  act(() => runtime.commands.disclose("diagnostics", true));
  expect(details).toHaveAttribute("open");
  act(() => {
    context.history.round = { roundId: "round", targets: [{ key: "page", resultRevisionId: "result", comparison: {
      content: { available: false, reason: "<script>not executed</script>" },
      source: { available: false, reason: "Missing Source" },
    } }] };
    runtime.publish();
  });
  expect(details).toHaveAttribute("open");
  expect(screen.getByText(/<script>not executed/)).toBeVisible();
  expect(screen.queryByRole("button", { name: "Content" })).toBeNull();
});
it("surfaces history failures and recovery while keeping capture disabled for stale frame context", () => {
  const { context, runtime, capture } = fixture();
  act(() => {
    context.current.pendingReload = true;
    context.history.error = { message: "History temporarily offline" };
    runtime.publish();
  });
  expect(screen.getByRole("alert")).toHaveTextContent("History temporarily offline");
  expect(screen.getByRole("button", { name: "Retry history" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Capture result" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Capture result" }));
  expect(capture).not.toHaveBeenCalled();
});

function detailFixture() {
  const value = fixture();
  const header = document.createElement("div");
  const headingSlot = header.appendChild(document.createElement("div"));
  const root = document.createElement("div");
  const rows = Array.from({ length: 40 }, (_, index) => ({
    id: `row-${index}`, kind: index === 0 || index === 39 ? "modified" as const : "unchanged" as const,
    changeId: index === 0 ? "first" : index === 39 ? "last" : null,
    beforeBlock: { text: `Before ${index}`, tag: "p" },
    afterBlock: { text: `After ${index}`, tag: "p" },
  }));
  act(() => {
    value.context.history.round!.targets![0].comparison = {
      content: { available: true, rows, changes: [{ id: "first" }, { id: "last" }] },
      source: { available: true, changes: [{ id: "source", after: "Source line" }] },
    };
    value.runtime.publish();
  });
  const view = render(<StrictMode><ChangesDetail runtime={value.runtime} root={root} headingSlot={headingSlot} header={header}/></StrictMode>);
  view.container.append(header, root);
  return { ...value, root, headingSlot, header };
}

it("scrolls the committed controlled row once, not the previous row or a stale request", () => {
  const { runtime, context, root, header } = detailFixture();
  const headerBounds = vi.spyOn(header, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 320, 128));
  const scrolled: Element[] = [];
  const scroll = vi.fn(function (this: Element) {
    expect(this).toBe(root.querySelector(".comparison-current"));
    expect(root.style.getPropertyValue("--comparison-header-height")).toBe(`${header.getBoundingClientRect().height}px`);
    scrolled.push(this);
  });
  const original = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
  Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: scroll });
  try {
    act(() => runtime.commands.jump(1, runtime.getSnapshot().key));
    expect(scrolled[0]).toHaveAttribute("data-row-id", "row-39");
    act(() => { context.current.dirty = true; runtime.publish(); });
    expect(scroll).toHaveBeenCalledTimes(1);
    act(() => runtime.commands.selectMode("source"));
    expect(runtime.getSnapshot().scrollRequest).toBeNull();
    expect(scroll).toHaveBeenCalledTimes(1);
    headerBounds.mockReturnValue(new DOMRect(0, 0, 320, 192));
    act(() => runtime.commands.jump(0, runtime.getSnapshot().key));
    expect(scrolled[1]).toHaveAttribute("data-row-id", "legacy-row-0");
    act(() => { context.comparing = false; runtime.publish(); });
    act(() => runtime.commands.jump(0, runtime.getSnapshot().key));
    act(() => { context.comparing = true; runtime.publish(); });
    expect(scroll).toHaveBeenCalledTimes(2);
  } finally {
    headerBounds.mockRestore();
    if (original) Object.defineProperty(Element.prototype, "scrollIntoView", original);
    else Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  }
});

it("retains portal rows, expanded context and text selection across equivalent history and destination publications", () => {
  const { context, runtime, root, headingSlot } = detailFixture();
  fireEvent.click(root.querySelector(".comparison-expand")!);
  const row = root.querySelector('[data-row-id="row-10"]')!;
  const heading = headingSlot.firstChild;
  const range = document.createRange();
  range.selectNodeContents(row.querySelector("p")!);
  document.getSelection()!.addRange(range);
  const selected = document.getSelection()!.toString();
  act(() => {
    context.history.round = structuredClone(context.history.round);
    runtime.publish();
    runtime.commands.disclose("diagnostics", true);
  });
  expect(root.querySelector('[data-row-id="row-10"]')).toBe(row);
  expect(headingSlot.firstChild).toBe(heading);
  expect(document.getSelection()!.toString()).toBe(selected);
  act(() => { context.comparing = false; runtime.publish(); });
  act(() => { context.comparing = true; runtime.publish(); });
  expect(root.querySelector('[data-row-id="row-10"]')).toBe(row);
  act(() => runtime.commands.selectMode("source"));
  act(() => runtime.commands.selectMode("content"));
  expect(root.querySelector('[data-row-id="row-10"]')).toBeNull();
  document.getSelection()!.removeAllRanges();
});
