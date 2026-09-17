import { StrictMode } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { SemanticBlock } from "../../src/contracts/history";
import { compareSemanticSnapshots, compareSources } from "../../src/revision-diff.js";
import { ComparisonPortal, ComparisonView, type ComparisonInput } from "../../src/ui/components/comparison";
import { projectComparison, type SavedRow } from "../../src/ui/comparison/projection";

afterEach(cleanup);
const block = (text: string, tag = "p", extra: Partial<SemanticBlock> = {}): SemanticBlock => ({
  id: "b1", tag, text, path: ["body"], selector: "body > p:nth-of-type(1)",
  attributes: {}, runs: text ? [{ text, marks: [] }] : [], ...extra,
});
const snapshot = (blocks: SemanticBlock[]) => ({ version: 1, limitations: [], blocks: blocks.map((item, index) => ({ ...item, id: `b${index}` })) });
function comparison(before: SemanticBlock[], after: SemanticBlock[]): ComparisonInput {
  const result = compareSemanticSnapshots(snapshot(before), snapshot(after));
  expect(result.status).toBe("complete");
  return result;
}
function setup(before: SemanticBlock[], after: SemanticBlock[]) {
  const value = comparison(before, after);
  return { ...render(<ComparisonView comparison={value} />), comparison: value };
}
const text = (root: ParentNode, selector: string) => root.querySelector(selector)?.textContent;

describe("Content projection", () => {
  it("retains heading and inline run boundaries inside saved word segments", () => {
    const before = block("A bold old phrase", "h2", { runs: [
      { text: "A ", marks: [] }, { text: "bold old", marks: ["strong"] }, { text: " phrase", marks: ["em"] },
    ] });
    const after = block("A bold new phrase", "h2", { runs: [
      { text: "A ", marks: [] }, { text: "bold new", marks: ["strong"] }, { text: " phrase", marks: ["em"] },
    ] });
    const { container } = setup([before], [after]);
    expect(text(container, ".comparison-before h2")).toBe(before.text);
    expect(text(container, ".comparison-after h2")).toBe(after.text);
    expect(text(container, "del strong")).toBe("old");
    expect(text(container, "ins strong")).toBe("new");
    expect(text(container, ".comparison-after em")).toBe(" phrase");
  });

  it("keeps historical markup, URLs and control names inert without issuing resources", () => {
    const { container } = setup([
      block("link", "button", { runs: [{ text: "link", marks: [], href: "/old" }] }),
      block("", "img", { attributes: { src: "/old.png", alt: "Before image" } }),
      block("<script>window.bad=true</script>", "script"),
    ], [
      block("link", "button", { runs: [{ text: "link", marks: [], href: "javascript:fetch('https://invalid.example/private')" }] }),
      block("", "img", { attributes: { src: "https://invalid.example/tracker.png?token=saved", alt: "After image" } }),
      block("<script>window.bad=false</script>", "script"),
    ]);
    expect(container.querySelector("script, style, img, iframe, a, input, button:not(.comparison-expand), [href], [src], [onclick]")).toBeNull();
    expect(container.textContent).toContain("Link destination: /old");
    expect(container.textContent).toContain("Image not loaded");
    expect(container.textContent).toContain("<script>window.bad=false</script>");
    expect(container.querySelector(".comparison-after .saved-link")?.getAttribute("title")).toContain("javascript:fetch");
  });

  it("rejects authored properties and unknown marks even on malformed saved input", () => {
    const input: unknown = JSON.parse(`{"rows":[null,{"id":"bad","kind":"modified","changeId":"bad","afterBlock":{
      "text":"<img src=x onerror=alert(1)>","tag":"iframe","selector":null,"path":[{}, "body"],"attributes":{
      "src":"https://invalid.example/pixel","style":"background:url(https://invalid.example/pixel)","onclick":"alert(1)","bad":{}},
      "runs":[null,{"text":4},{"text":"<img src=x onerror=alert(1)>","marks":["constructor","__proto__","script","strong",{}],"href":"data:text/html,<script>alert(1)</script>"}]}}]}`);
    const safe = projectComparison(input);
    const { container } = render(<ComparisonView comparison={{ rows: safe.rows, changes: safe.changes }} />);
    expect(text(container, ".comparison-after strong")).toBe("<img src=x onerror=alert(1)>");
    expect(container.querySelector("img, iframe, script, a, [src], [href], [style], [onclick]")).toBeNull();
    expect(() => projectComparison({ rows: [{ beforeBlock: { tag: "ol" }, afterBlock: { text: 4, runs: {} } }] })).not.toThrow();
    expect(projectComparison(null).rows).toEqual([]);
  });

  it("reconstructs only positional table rows and safe spans", () => {
    const cell = (value: string, row: number, col: number, tag = "td", attributes = {}) => block(value, tag, {
      selector: `body > table:nth-of-type(1) > tbody:nth-of-type(1) > tr:nth-of-type(${row}) > ${tag}:nth-of-type(${col})`, attributes,
    });
    const before = [cell("Name", 1, 1, "th", { colspan: "2", rowspan: "3" }), cell("Value", 1, 2, "th"),
      cell("Next row", 2, 1, "td", { colspan: "101" }), block("Mystery", "td", { path: ["table", "tbody", "tr"] })];
    const { container } = setup(before, before);
    const tables = container.querySelectorAll(".comparison-before table");
    expect(tables).toHaveLength(2);
    expect(tables[0].querySelector("tr")?.children).toHaveLength(2);
    expect(tables[0].querySelector("th")?.colSpan).toBe(2);
    expect(tables[0].querySelector("th")?.hasAttribute("rowspan")).toBe(false);
    expect(tables[1].querySelector("td")?.hasAttribute("colspan")).toBe(false);
    expect(container.textContent).toContain("Saved row span: 3 · shown in row order");
    expect(container.textContent).toContain("Table cell · row structure unavailable");
    expect(tables[0].getAttribute("aria-label")).toBe("Saved table row");
  });

  it.each([
    [{ start: "4" }, [4, 5]],
    [{ reversed: "" }, [2, 1]],
    [{ start: "0" }, [0, 1]],
    [{ start: "7", reversed: "" }, [7, 6]],
  ])("retains ordered-list numbering for %j", (attributes, expected) => {
    const before = [
      block("", "ol", { selector: "body > ol:nth-of-type(1)", attributes }),
      block("One", "li", { selector: "body > ol:nth-of-type(1) > li:nth-of-type(1)", path: ["body", "ol"] }),
      block("Two", "li", { selector: "body > ol:nth-of-type(1) > li:nth-of-type(2)", path: ["body", "ol"] }),
    ];
    const { container } = setup(before, before);
    expect([...container.querySelectorAll(".comparison-before ol")].map((list) => list.getAttribute("start"))).toEqual(expected.map(String));
  });

  it("keeps explicit list values, nested indentation and unavailable parent labels", () => {
    const before = [
      block("Reset", "li", { path: ["body", "ol", "ul", "ol"], attributes: { value: "12" } }),
      block("Next", "li", { path: ["body", "ol", "ul", "ol"] }),
      block("Bullet", "li", { path: ["body", "ul"] }),
      block("Unknown", "li"),
    ];
    const { container } = setup(before, before.map((item) => ({ ...item, text: `${item.text}!`, runs: [{ text: `${item.text}!`, marks: [] }] })));
    expect([...container.querySelectorAll(".comparison-before ol")].map((list) => list.getAttribute("start"))).toEqual(["12", "13"]);
    expect(container.querySelector<HTMLOListElement>(".comparison-before ol")?.style.marginInlineStart).toBe("28px");
    expect(container.querySelectorAll(".comparison-before ul")).toHaveLength(2);
    expect(container.textContent).toContain("List item · parent structure unavailable");
  });

  it("shows metadata-only attribute, formatting, element and structure changes", () => {
    const before = [
      block("Text", "p", { attributes: { href: "/old" } }),
      block("Formatted"),
      block("Moved", "p", { path: ["body", "section"] }),
      block("Heading", "h2"),
    ];
    const after = [
      block("Text", "p", { attributes: { href: "/new" } }),
      block("Formatted", "p", { runs: [{ text: "Formatted", marks: ["strong", "em"] }] }),
      block("Moved", "p", { path: ["body", "article"] }),
      block("Heading", "h3"),
    ];
    const { container } = setup(before, after);
    expect(container.textContent).toContain("Link destination: /old");
    expect(container.textContent).toContain("Link destination: /new");
    expect(container.textContent).toContain("Inline formatting changed");
    expect(container.textContent).toContain("Structure: body › article");
    expect(container.textContent).toContain("Element: h3");
    expect(text(container, ".comparison-after em strong")).toBe("Formatted");
  });

  it("retains readable structures, complete mark allowlist and non-color change labels", () => {
    const before = [block("Same"), block("Original", "blockquote")];
    const after = [block("Same"), block("Updated", "blockquote", {
      runs: [{ text: "Updated", marks: ["strong", "em", "underline", "strike", "delete", "insert", "code", "kbd", "samp", "sub", "sup", "mark"] }],
    })];
    const { container } = setup(before, after);
    expect(text(container, ".comparison-unchanged .comparison-mobile-label")).toBe("Unchanged · both versions");
    expect(container.querySelector(".comparison-unchanged .comparison-after")).not.toBeNull();
    expect(container.querySelector(".comparison-row:not(.comparison-unchanged) .comparison-before")?.getAttribute("aria-label")).toBe("Before · modified");
    expect(text(container, ".comparison-row:not(.comparison-unchanged) .comparison-after .comparison-mobile-label")).toBe("After · modified");
    expect(text(container, ".comparison-change-label")).toBe("Modified");
    for (const tag of ["blockquote", "strong", "em", "u", "s", "code", "kbd", "samp", "sub", "sup", "mark"]) {
      expect(container.querySelector(`.comparison-after ${tag}`)).not.toBeNull();
    }
  });

  it("labels changed empty containers, saved controls, removal and uncertain relocation", () => {
    const rows: SavedRow[] = [
      { id: "structure", kind: "added", changeId: "structure", afterBlock: block("", "table") },
      { id: "remove", kind: "removed", changeId: "remove", beforeBlock: block("Removed", "button") },
      { id: "move", kind: "removed", changeId: "move", moveId: "relocated", beforeBlock: block("Moved", "summary") },
    ];
    const { container } = render(<ComparisonView comparison={{ rows, changes: rows.map((row) => ({ id: row.changeId || "" })) }} />);
    expect(container.textContent).toContain("table structure added");
    expect(container.textContent).toContain("Saved button · inactive");
    expect(container.querySelector('[data-change-id="remove"]')?.getAttribute("title")).toBe("Removed content has no target on the latest page.");
    expect(container.querySelector('[data-change-id="move"]')?.getAttribute("title")).toBeNull();
    expect(container.textContent).toContain("↔ Relocated content · original position (identity not certain)");
  });

  it("shows saved ID/attribute removal as metadata without assigning it to elements", () => {
    const beforeBlock = block("Same", "p", { attributes: { id: "captured-id", alt: "Old alternative", title: "Saved title" } });
    const afterBlock = block("Same", "p", { attributes: { id: "replacement-id" } });
    const { container } = render(<ComparisonView comparison={{
      rows: [{ id: "row", kind: "modified", changeId: "change", beforeBlock, afterBlock }],
      changes: [{ id: "change", kind: "modified", beforeBlock, afterBlock, fields: ["attributes"] }],
    }} />);
    expect(text(container, ".comparison-before")).toContain("Element ID: captured-id");
    expect(text(container, ".comparison-after")).toContain("Element ID: replacement-id");
    expect(text(container, ".comparison-after")).toContain("Alternative text: (not set)");
    expect(text(container, ".comparison-after")).toContain("title: (not set)");
    expect(container.querySelector("[id], [alt], [title]")).toBeNull();
  });

  it("continues word segments across run boundaries and handles missing or short saved runs", () => {
    const beforeBlock = block("abc old xyz", "p", { runs: [
      { text: "abc o", marks: ["strong"] }, { text: "ld ", marks: ["em"] }, { text: "xyz", marks: [] },
    ] });
    const afterBlock = block("abc new xyz", "p", { runs: [
      { text: "abc n", marks: ["strong"] }, { text: "ew ", marks: ["em"] }, { text: "xyz", marks: [] },
    ] });
    const value: ComparisonInput = { rows: [{
      id: "runs", kind: "modified", changeId: "runs", beforeBlock, afterBlock,
      segments: [{ value: "abc " }, { value: "old", removed: true }, { value: "new", added: true }, { value: " xyz" }],
    }], changes: [{ id: "runs" }] };
    const view = render(<ComparisonView comparison={value} />);
    expect(text(view.container, ".comparison-before p")).toBe("abc old xyz");
    expect(text(view.container, ".comparison-after p")).toBe("abc new xyz");
    expect([...view.container.querySelectorAll("del")].map((node) => node.textContent).join("")).toBe("old");
    expect(text(view.container, "del strong")).toBe("o");
    expect(text(view.container, "del em")).toBe("ld");
    expect(text(view.container, "ins strong")).toBe("n");
    view.rerender(<ComparisonView comparison={{ rows: [{
      id: "fallback", kind: "modified", beforeBlock: { text: "Missing runs" },
      afterBlock: { text: "Short runs", runs: [{ text: "", marks: ["strong"] }, { text: "Sh", marks: ["em"] }] },
    }] }} />);
    expect(text(view.container, ".comparison-before p")).toBe("Missing runs");
    expect(text(view.container, ".comparison-after p")).toBe("Short runs");
    expect(text(view.container, ".comparison-after em")).toBe("Sh");
  });

  it("omits empty unchanged containers, retains horizontal rules and labels definition/caption content", () => {
    const blocks = [
      block("", "table"), block("", "tbody"), block("", "tr"),
      ...["hr", "pre", "address", "dt", "dd", "caption", "figcaption"].map((tag) => block(tag === "hr" ? "" : `Saved ${tag}`, tag)),
    ];
    const { container } = setup(blocks, blocks);
    while (container.querySelector(".comparison-expand")) fireEvent.click(container.querySelector(".comparison-expand")!);
    expect(container.querySelectorAll(".comparison-row")).toHaveLength(7);
    expect(container.querySelectorAll(".comparison-before hr")).toHaveLength(1);
    expect(text(container, ".comparison-before pre")).toBe("Saved pre");
    expect(text(container, ".comparison-before address")).toBe("Saved address");
    expect([...container.querySelectorAll(".comparison-before .structure-note")].map((node) => node.textContent)).toEqual(["dt", "dd", "caption", "figcaption"]);
  });
});

describe("context and React ownership", () => {
  function contextFixture(length = 45, changeAt = 20) {
    const before = Array.from({ length }, (_, index) => block(`Paragraph ${index}`, "p", { attributes: { id: `p${index}` } }));
    return comparison(before, before.map((item, index) => index === changeAt ? { ...item, text: "Changed", runs: [{ text: "Changed", marks: [] }] } : item));
  }
  it("expands bounded context, keeps every change and preserves DOM and text selection on selection/freshness updates", () => {
    const value = contextFixture();
    const view = render(<StrictMode><ComparisonView comparison={value} /></StrictMode>);
    expect(view.container.querySelectorAll(".comparison-row")).toHaveLength(5);
    const first = view.container.querySelector(".comparison-row");
    const paragraph = first?.querySelector("p");
    fireEvent.click(view.container.querySelector(".comparison-expand")!);
    expect(view.container.querySelectorAll(".comparison-row")).toHaveLength(23);
    expect(paragraph?.firstChild).toBeTruthy();
    const selection = window.getSelection();
    const range = document.createRange();
    if (!paragraph?.firstChild) throw new Error("Missing paragraph text");
    range.setStart(paragraph.firstChild, 2);
    range.setEnd(paragraph.firstChild, 9);
    selection?.removeAllRanges();
    selection?.addRange(range);
    const fresh = { ...value, afterCapturedAt: 123 };
    view.rerender(<StrictMode><ComparisonView comparison={fresh} selectedIndex={0} /></StrictMode>);
    expect(first?.isConnected).toBe(true);
    expect(first?.querySelector("p")).toBe(paragraph);
    expect(selection?.toString()).toBe("ragraph");
    expect(view.container.querySelectorAll(".comparison-current")).toHaveLength(1);
    expect(view.container.querySelectorAll(".comparison-row")).toHaveLength(23);
    const copied: ComparisonInput = JSON.parse(JSON.stringify(value));
    view.rerender(<StrictMode><ComparisonView comparison={copied} selectedIndex={null} /></StrictMode>);
    expect(view.container.querySelectorAll(".comparison-current")).toHaveLength(0);
    expect(first?.isConnected).toBe(true);
    expect(view.container.querySelectorAll(".comparison-row")).toHaveLength(23);
  });

  it("reveals at most twenty context units per click and transfers focus when exhausted", () => {
    const view = render(<ComparisonView comparison={contextFixture(80, 50)} />);
    const button = view.container.querySelector(".comparison-expand")!;
    expect(button.textContent).toBe("↕ Show 20 of 48 unchanged blocks");
    fireEvent.click(button);
    expect(view.container.querySelectorAll(".comparison-row")).toHaveLength(25);
    expect(button.textContent).toBe("↕ Show 20 of 28 unchanged blocks");
    fireEvent.click(button);
    expect(button.textContent).toBe("↕ Show 8 of 8 unchanged blocks");
    fireEvent.click(button);
    expect(button.isConnected).toBe(false);
    expect(document.activeElement?.getAttribute("data-row-id")).toBe(view.container.querySelectorAll(".comparison-row")[47].getAttribute("data-row-id"));
    expect(document.activeElement?.getAttribute("tabindex")).toBe("-1");
  });

  it("resets expansion on round/target, mode or saved content change, but not selection", () => {
    const value = contextFixture();
    const view = render(<ComparisonView comparison={value} comparisonKey="round:target" />);
    fireEvent.click(view.container.querySelector(".comparison-expand")!);
    view.rerender(<ComparisonView comparison={value} comparisonKey="another:target" />);
    expect(view.container.querySelectorAll(".comparison-row")).toHaveLength(5);
    fireEvent.click(view.container.querySelector(".comparison-expand")!);
    view.rerender(<ComparisonView comparison={value} comparisonKey="another:target" mode="source" />);
    expect(view.container.querySelectorAll(".comparison-row")).toHaveLength(5);
    fireEvent.click(view.container.querySelector(".comparison-expand")!);
    view.rerender(<ComparisonView comparison={contextFixture(45, 21)} comparisonKey="another:target" mode="source" />);
    expect(view.container.querySelectorAll(".comparison-row")).toHaveLength(5);
  });

  it("uses stable two-slot portals and removes headings for unavailable, pending or budget results", () => {
    const host = document.createElement("section");
    const headingSlot = document.createElement("div");
    const root = document.createElement("article");
    host.append(headingSlot, root);
    document.body.append(host);
    try {
      const value = compareSources("Original\n", "Updated\n");
      const view = render(<ComparisonPortal root={root} headingSlot={headingSlot} comparison={value} mode="source" />);
      const heading = headingSlot.firstElementChild;
      expect(text(headingSlot, ".comparison-headings")).toBe("Before · feedback sentAfter · captured result");
      expect(root.querySelector(".comparison-headings")).toBeNull();
      view.rerender(<ComparisonPortal root={root} headingSlot={headingSlot} comparison={{ ...value }} mode="source" selectedIndex={0} />);
      expect(headingSlot.firstElementChild).toBe(heading);
      view.rerender(<ComparisonPortal root={root} headingSlot={headingSlot} comparison={{ available: false, rows: [], changes: [] }} />);
      expect(headingSlot.textContent).toBe("");
      expect(root.textContent).toBe("");
      view.rerender(<ComparisonPortal root={root} headingSlot={headingSlot} comparison={null} fallback={<p role="status">Loading comparison…</p>} />);
      expect(root.textContent).toBe("Loading comparison…");
      expect(headingSlot.textContent).toBe("");
    } finally { host.remove(); }
  });

  it("preserves excerpt-only fallback and empty/no-change notices", () => {
    const value: ComparisonInput = { changes: [{ kind: "modified", before: "<h1>old</h1>", after: "<h1>new</h1>" }] };
    const view = render(<ComparisonView comparison={value} selectedIndex={0} />);
    expect(view.container.textContent).toContain("Saved excerpts only · unchanged context was not recorded");
    expect(text(view.container, ".comparison-before p")).toBe("<h1>old</h1>");
    expect(view.container.querySelector(".comparison-current")?.getAttribute("data-row-id")).toBe("legacy-row-0");
    view.rerender(<ComparisonView comparison={{ rows: [], changes: [] }} />);
    expect(view.container.textContent).toBe("No changes detected in this comparison format.");
    const unchanged = Array.from({ length: 10 }, (_, index) => block(`Same ${index}`));
    view.rerender(<ComparisonView comparison={comparison(unchanged, unchanged)} />);
    expect(view.container.querySelectorAll(".comparison-row")).toHaveLength(3);
    expect(view.container.querySelector(".comparison-expand")?.textContent).toBe("↕ Show 7 of 7 unchanged blocks");
  });

  it("fails the original 120000-node budget explicitly rather than rendering a truncated view", () => {
    const rows: SavedRow[] = Array.from({ length: 4000 }, (_, index) => ({
      id: `${index}`, kind: "modified", beforeBlock: block("before"), afterBlock: block("after"),
    }));
    const { container } = render(<ComparisonView comparison={{ rows }} />);
    expect(container.querySelector(".comparison-budget")?.textContent).toContain("Comparison rendering limit exceeded");
    expect(container.querySelector(".comparison-row, .comparison-headings, .comparison-expand")).toBeNull();
  });

  it("moves the controlled active class without replacing either changed row or their text", () => {
    const value = comparison([block("First old"), block("Second old")], [block("First new"), block("Second new")]);
    expect(value.changes).toHaveLength(2);
    const view = render(<ComparisonView comparison={value} selectedIndex={0} />);
    const rows = [...view.container.querySelectorAll(".comparison-row")];
    const firstText = rows[0].querySelector("p")?.firstChild;
    expect(rows[0].classList.contains("comparison-current")).toBe(true);
    view.rerender(<ComparisonView comparison={value} selectedIndex={1} />);
    expect(rows[0].classList.contains("comparison-current")).toBe(false);
    expect(rows[1].classList.contains("comparison-current")).toBe(true);
    expect([...view.container.querySelectorAll(".comparison-row")]).toEqual(rows);
    expect(rows[0].querySelector("p")?.firstChild).toBe(firstText);
  });

  it("groups unchanged and changed positional cells and selects only the first relocated unit", () => {
    const selector = "body > table:nth-of-type(1) > tbody:nth-of-type(1) > tr:nth-of-type(1)";
    const first = block("First", "th", { selector: `${selector} > th:nth-of-type(1)` });
    const second = block("Second", "td", { selector: `${selector} > td:nth-of-type(1)` });
    const value: ComparisonInput = { rows: [
      { id: "first", kind: "unchanged", beforeBlock: first, afterBlock: first },
      { id: "second", kind: "modified", changeId: "second", beforeBlock: second, afterBlock: second },
      { id: "second-result", kind: "added", changeId: "second", afterBlock: block("Second") },
    ], changes: [{ id: "first" }, { id: "second" }] };
    const view = render(<ComparisonView comparison={value} selectedIndex={1} />);
    expect(view.container.querySelectorAll(".comparison-row")).toHaveLength(2);
    expect(view.container.querySelectorAll(".comparison-current")).toHaveLength(1);
    expect(view.container.querySelector(".comparison-current")?.getAttribute("data-row-id")).toBe("first");
    expect(text(view.container, ".comparison-change-label")).toBe("Modified");
    expect(view.container.querySelector(".comparison-after table tr")?.children).toHaveLength(2);
  });
});

describe("Source projection", () => {
  it("keeps literal HTML, gaps, line numbers, added runs and EOF labels", () => {
    const { container } = render(<ComparisonView comparison={compareSources("same\n", "same\n<script>inert</script>")} mode="source" />);
    expect(container.querySelectorAll(".comparison-row")).toHaveLength(2);
    expect(container.querySelectorAll(".comparison-gap")).toHaveLength(1);
    expect(container.querySelector("script")).toBeNull();
    expect(text(container, ".comparison-row:last-child .comparison-after .comparison-gutter")).toBe("2 +");
    expect(text(container, ".comparison-row:last-child .comparison-after ins")).toBe("<script>inert</script>");
    expect(container.textContent).toContain("No newline at end of file");
    expect(text(container, ".comparison-unchanged .comparison-mobile-label")).toBe("Unchanged · Before 1 / After 1");
  });

  it("retains removed source and one-sided empty-file diagnostics", () => {
    const { container } = render(<ComparisonView comparison={compareSources("deleted", "")} mode="source" />);
    expect(text(container, ".comparison-before del")).toBe("deleted");
    expect(text(container, ".comparison-before .comparison-gutter")).toBe("1 −");
    expect(container.querySelector(".comparison-after")?.classList.contains("comparison-gap")).toBe(true);
    expect(container.querySelectorAll(".newline-note")).toHaveLength(1);
  });

  it("displays CRLF-only changes and missing-final-newline changes explicitly", () => {
    const view = render(<ComparisonView comparison={compareSources("same\r\n", "same\n")} mode="source" />);
    expect(text(view.container, ".comparison-before .newline-note")).toBe("Line ending: CRLF");
    expect(text(view.container, ".comparison-after .newline-note")).toBe("Line ending: LF");
    expect(text(view.container, ".comparison-before pre")).toBe("same\r\n");
    view.rerender(<ComparisonView comparison={compareSources("same\n", "same")} mode="source" />);
    expect(text(view.container, ".comparison-after .newline-note")).toBe("↵ No newline at end of file");
    expect(view.container.textContent).toContain("Line ending: none");
  });

  it("retains long literal lines without truncating or interpreting HTML", () => {
    const long = `<style>${"x".repeat(10000)}</style>\t & <b>literal</b>`;
    const { container } = render(<ComparisonView comparison={compareSources("short\n", long)} mode="source" />);
    expect(text(container, ".comparison-after pre")).toBe(long);
    expect(container.querySelector("style, b")).toBeNull();
  });

  it("uses line context expansion and updated line numbers after an insertion", () => {
    const before = Array.from({ length: 55 }, (_, index) => `line ${index}\n`).join("");
    const after = `inserted\n${before}`;
    const { container } = render(<ComparisonView comparison={compareSources(before, after)} mode="source" />);
    expect(container.querySelectorAll(".comparison-row")).toHaveLength(3);
    expect(container.querySelector(".comparison-expand")?.textContent).toBe("↕ Show 20 of 53 unchanged lines");
    expect(text(container, ".comparison-row:nth-of-type(3) .comparison-before .comparison-gutter")).toBe("1 ");
    expect(text(container, ".comparison-row:nth-of-type(3) .comparison-after .comparison-gutter")).toBe("2 ");
    fireEvent.click(container.querySelector(".comparison-expand")!);
    expect(container.querySelectorAll(".comparison-row")).toHaveLength(23);
  });
});
