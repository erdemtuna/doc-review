// Historical content is reconstructed with inert, allowlisted DOM nodes only.
// Never assign captured attributes, HTML, URLs, or authored styles to the DOM.
const marks = {
  strong: "strong", em: "em", underline: "u", strike: "s", delete: "s",
  insert: "u", code: "code", kbd: "kbd", samp: "samp", sub: "sub",
  sup: "sup", mark: "mark",
};
const containers = new Set(["table", "thead", "tbody", "tfoot", "tr", "ul", "ol", "dl"]);
const readable = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "p", "pre", "blockquote", "address"]);
const node = (document, tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};
const sourceLines = (block) => block?.startLine ?? "";
const rowParent = (block) => {
  if (!["td", "th"].includes(block?.tag)) return null;
  // A bare path such as table/tbody/tr does not distinguish repeated rows.
  // Only the saved positional selector is sufficient for row reconstruction.
  return block.selector?.match(/^(.* > tr(?::nth-of-type\(\d+\))?(?:\[id=".*"\])?) > (?:td|th):nth-of-type\(\d+\)/)?.[1] || null;
};

function appendRuns(element, block, segments, side) {
  const document = element.ownerDocument;
  const parts = segments?.length
    ? segments.filter((part) => side === "before" ? !part.added : !part.removed)
    : [{ value: block.text }];
  const runs = block.runs || [{ text: block.text, marks: [] }];
  let runIndex = 0;
  let runOffset = 0;
  for (const part of parts) {
    let offset = 0;
    while (offset < part.value.length) {
      while (runIndex < runs.length && runOffset >= runs[runIndex].text.length) {
        runIndex++;
        runOffset = 0;
      }
      const run = runs[runIndex];
      const length = Math.min(part.value.length - offset, run ? run.text.length - runOffset : Infinity);
      let leaf = document.createTextNode(part.value.slice(offset, offset + length));
      for (const mark of run?.marks || []) {
        if (!Object.hasOwn(marks, mark)) continue;
        const wrapper = node(document, marks[mark]);
        wrapper.append(leaf);
        leaf = wrapper;
      }
      if (run?.href) {
        const reference = node(document, "span", "saved-link");
        reference.title = `Saved link: ${run.href} (not opened from history)`;
        reference.append(leaf);
        leaf = reference;
      }
      if (side === "before" ? part.removed : part.added) {
        const emphasis = node(document, side === "before" ? "del" : "ins");
        emphasis.append(leaf);
        leaf = emphasis;
      }
      element.append(leaf);
      offset += length;
      runOffset += length;
    }
  }
}

function metadata(block, change, side) {
  if (!change || !block) return [];
  const other = change[side === "before" ? "afterBlock" : "beforeBlock"];
  if (!other) return [];
  const labels = [];
  if (block.tag !== other.tag) labels.push(`Element: ${block.tag}`);
  for (const key of new Set([...Object.keys(block.attributes || {}), ...Object.keys(other.attributes || {})])) {
    if (block.attributes?.[key] === other.attributes?.[key]) continue;
    const name = { href: "Link destination", src: "Image reference", alt: "Alternative text", id: "Element ID" }[key] || key;
    labels.push(`${name}: ${block.attributes?.[key] ?? "(not set)"}`);
  }
  const links = [...new Set((block.runs || []).map((run) => run.href).filter(Boolean))];
  const otherLinks = [...new Set((other.runs || []).map((run) => run.href).filter(Boolean))];
  if (JSON.stringify(links) !== JSON.stringify(otherLinks)) labels.push(`Link destination: ${links.join(", ") || "(none)"}`);
  if (change.fields?.includes("runs") && block.text === other.text && !labels.length) labels.push("Inline formatting changed");
  if (change.fields?.includes("structure") && block.tag === other.tag) {
    labels.push(`Structure: ${(block.path || []).join(" › ") || "document root"}`);
  }
  return labels;
}

function renderBlock(document, row, side, mode, change, listNumbers) {
  const block = row[`${side}Block`];
  const wrapper = node(document, "div", "comparison-block");
  if (!block) return wrapper;
  if (mode === "source") {
    const pre = node(document, "pre");
    appendRuns(pre, block, row.segments, side);
    wrapper.append(pre);
    if (!block.text.endsWith("\n")) wrapper.append(node(document, "small", "newline-note", "↵ No newline at end of file"));
    const other = row[side === "before" ? "afterBlock" : "beforeBlock"];
    const ending = (text) => text.endsWith("\r\n") ? "CRLF" : text.endsWith("\n") ? "LF" : "none";
    if (other && ending(block.text) !== ending(other.text)) {
      wrapper.append(node(document, "small", "newline-note", `Line ending: ${ending(block.text)}`));
    }
    return wrapper;
  }
  const tag = block.tag || "p";
  if (tag === "img") {
    const image = node(document, "figure", "saved-image");
    image.append(node(document, "figcaption", "", `Image: ${block.attributes?.alt || "No saved alternative text"}`));
    image.append(node(document, "small", "", `Saved reference: ${block.attributes?.src || "unavailable"} · Image not loaded`));
    wrapper.append(image);
  } else if (tag === "hr") {
    wrapper.append(node(document, "hr"));
  } else if (containers.has(tag) && !block.text) {
    if (change) wrapper.append(node(document, "small", "structure-note", `${tag} structure ${row.kind}`));
  } else {
    const text = node(document, readable.has(tag) ? tag : tag === "li" ? "li" : "p");
    appendRuns(text, block, row.segments, side);
    if (tag === "li") {
      const listTag = [...(block.path || [])].reverse().find((item) => /^(ul|ol)(#|$)/.test(item))?.split("#")[0];
      const list = node(document, listTag || "ul", "saved-list");
      if (listTag === "ol") list.start = listNumbers.get(block) ?? 1;
      const depth = (block.path || []).filter((item) => /^(ul|ol)(#|$)/.test(item)).length;
      list.style.marginInlineStart = `${Math.min(6, Math.max(0, depth - 1)) * 14}px`;
      list.append(text);
      wrapper.append(list);
      if (!listTag) wrapper.append(node(document, "small", "structure-note", "List item · parent structure unavailable"));
    } else {
      wrapper.append(text);
      if (["td", "th"].includes(tag) && !rowParent(block)) {
        wrapper.append(node(document, "small", "structure-note", "Table cell · row structure unavailable"));
      } else if (["button", "summary", "dt", "dd", "caption", "figcaption"].includes(tag)) {
        wrapper.append(node(document, "small", "structure-note", `${tag === "button" ? "Saved button · inactive" : tag}`));
      }
    }
  }
  for (const label of metadata(block, change, side)) wrapper.append(node(document, "small", "metadata-note", label));
  return wrapper;
}

function legacyRows(comparison) {
  return (comparison.changes || []).map((change, index) => ({
    id: `legacy-row-${index}`, kind: change.kind, changeId: change.id || `legacy-change-${index}`,
    beforeBlock: change.beforeBlock || (change.kind === "added" ? null : { text: change.before || "", tag: "p" }),
    afterBlock: change.afterBlock || (change.kind === "removed" ? null : { text: change.after || "", tag: "p" }),
    segments: change.segments || [],
  }));
}

function listPositions(rows, side) {
  const positions = new Map();
  const lists = new Map();
  for (const row of rows) {
    const block = row[`${side}Block`];
    if (!block) continue;
    if (block.tag === "ol") {
      const key = block.selector.replace(/\[id=".*"\]$/, "");
      const reversed = "reversed" in (block.attributes || {});
      const children = reversed ? rows.filter((candidate) => {
        const child = candidate[`${side}Block`];
        return child?.tag === "li" && child.selector?.replace(/ > li:nth-of-type\(\d+\).*$/, "") === key;
      }).length : 1;
      const start = block.attributes?.start;
      lists.set(key, {
        next: start !== undefined && Number.isSafeInteger(Number(start)) ? Number(start) : children,
        step: reversed ? -1 : 1,
      });
    }
    if (block.tag !== "li") continue;
    const key = block.selector?.replace(/ > li:nth-of-type\(\d+\).*$/, "") || (block.path || []).join("/");
    const list = lists.get(key) || { next: 1, step: 1 };
    lists.set(key, list);
    const explicit = block.attributes?.value;
    if (explicit !== undefined && Number.isFinite(Number(explicit))) list.next = Number(explicit);
    positions.set(block, list.next);
    list.next += list.step;
  }
  return positions;
}

export function createComparisonView(root) {
  const document = root.ownerDocument;
  const headingSlot = root.parentElement?.querySelector(".comparison-heading-slot");
  let signature;
  let inputs;
  let changes = [];
  let targets = new Map();
  let selected;
  return {
    render(comparison, { mode = "content", key = "" } = {}) {
      const nextInputs = [key, mode, comparison.version, comparison.status, comparison.available, comparison.rows, comparison.changes];
      if (inputs && nextInputs.every((value, index) => value === inputs[index])) return;
      inputs = nextInputs;
      // Immutable data identity includes content, not mutable timing/freshness notices.
      const nextSignature = `${key}:${mode}:${JSON.stringify([comparison.version, comparison.status, comparison.available, comparison.rows, comparison.changes])}`;
      if (signature === nextSignature) return;
      signature = nextSignature;
      selected = null;
      targets = new Map();
      changes = comparison.changes || [];
      const rows = comparison.rows || legacyRows(comparison);
      root.replaceChildren();
      headingSlot?.replaceChildren();
      root.className = `change-detail comparison-surface comparison-${mode}`;
      if (!rows.length) {
        if (comparison.available !== false) root.textContent = "No changes detected in this comparison format.";
        return;
      }
      // A budget failure is explicit and complete, not a silently truncated view.
      const nodes = rows.reduce((sum, row) => sum + ["before", "after"].reduce((n, side) => {
        const runs = row[`${side}Block`]?.runs || [];
        const depth = runs.reduce((maximum, run) => Math.max(maximum, run.marks.length), 0);
        return n + 12 + (runs.length + (row.segments?.length || 1)) * (depth + 4);
      }, 0), 0);
      if (nodes > 120000) {
        root.append(node(document, "p", "comparison-budget", "Comparison rendering limit exceeded. The saved comparison is intact; use Source or a smaller review round."));
        return;
      }
      if (!comparison.rows) root.append(node(document, "p", "comparison-notice", "Saved excerpts only · unchanged context was not recorded in this comparison."));
      const heads = node(document, "div", "comparison-headings");
      heads.append(node(document, "div", "", "Before · feedback sent"), node(document, "div", "", "After · captured result"));
      (headingSlot || root).append(heads);
      const changeMap = new Map(changes.map((change, index) => [change.id || `legacy-change-${index}`, change]));
      const numbers = { before: listPositions(rows, "before"), after: listPositions(rows, "after") };
      const units = [];
      for (const row of rows) {
        if (row.kind === "unchanged" && ["beforeBlock", "afterBlock"].every((side) =>
          !row[side] || (containers.has(row[side].tag) && !row[side].text))) continue;
        const tableKey = mode === "content" && (rowParent(row.beforeBlock) || rowParent(row.afterBlock))
          ? `${rowParent(row.beforeBlock) || ""}|${rowParent(row.afterBlock) || ""}` : null;
        const previous = units.at(-1);
        if (tableKey && previous?.tableKey === tableKey) previous.rows.push(row);
        else units.push({ rows: [row], tableKey });
      }
      const renderUnit = (unit) => {
        const pair = node(document, "div", "comparison-row");
        const unchanged = unit.rows.every((row) => row.kind === "unchanged");
        const kinds = [...new Set(unit.rows.map((row) => row.kind).filter((kind) => kind !== "unchanged"))];
        const changeLabel = kinds.map((kind) => ({ added: "Added", removed: "Removed", modified: "Modified" })[kind] || "Changed").join(" · ");
        if (unchanged) pair.classList.add("comparison-unchanged");
        pair.dataset.rowId = unit.rows[0].id;
        for (const side of ["before", "after"]) {
          const cell = node(document, "section", `comparison-cell comparison-${side}`);
          cell.setAttribute("aria-label", `${side === "before" ? "Before" : "After"} · ${unchanged ? "unchanged" : changeLabel.toLowerCase()}`);
          if (unit.rows.every((row) => !row[`${side}Block`])) cell.classList.add("comparison-gap");
          const changed = unit.rows.some((row) => row.kind !== "unchanged" && row[`${side}Block`]);
          if (changed) cell.classList.add(side === "before" ? "comparison-removed" : "comparison-added");
          const gutter = node(document, "span", "comparison-gutter", mode === "source"
            ? `${sourceLines(unit.rows[0][`${side}Block`])} ${changed ? side === "before" ? "−" : "+" : ""}`
            : changed ? side === "before" ? "−" : "+" : "");
          gutter.setAttribute("aria-hidden", "true");
          cell.append(gutter);
          const body = node(document, "div", "comparison-cell-body");
          const mobileLabel = node(document, "span", "comparison-mobile-label", unchanged
            ? mode === "source" ? `Unchanged · Before ${sourceLines(unit.rows[0].beforeBlock)} / After ${sourceLines(unit.rows[0].afterBlock)}` : "Unchanged · both versions"
            : `${side === "before" ? "Before" : "After"} · ${changeLabel.toLowerCase()}`);
          body.append(mobileLabel);
          if (changed) body.append(node(document, "span", "comparison-change-label", changeLabel));
          let tableRow;
          if (unit.tableKey) {
            const table = node(document, "table", "saved-table");
            table.setAttribute("aria-label", "Saved table row");
            const tbody = node(document, "tbody");
            tableRow = node(document, "tr");
            tbody.append(tableRow);
            table.append(tbody);
            body.append(table);
          }
          for (const row of unit.rows) {
            const block = row[`${side}Block`];
            const rendered = renderBlock(document, row, side, mode, changeMap.get(row.changeId), numbers[side]);
            if (row.changeId) {
              rendered.dataset.changeId = row.changeId;
              if (!targets.has(row.changeId)) targets.set(row.changeId, pair);
            }
            if (row.moveId && block) {
              rendered.append(node(document, "small", "metadata-note", `↔ Relocated content · ${side === "before" ? "original" : "result"} position (identity not certain)`));
            }
            if (row.kind === "removed" && side === "before" && !row.moveId) {
              rendered.title = "Removed content has no target on the latest page.";
            }
            if (tableRow) {
              const td = node(document, block?.tag === "th" ? "th" : "td");
              const colspan = Number(block?.attributes?.colspan);
              if (Number.isInteger(colspan) && colspan > 0 && colspan <= 100) td.colSpan = colspan;
              td.append(rendered);
              tableRow.append(td);
              if (block?.attributes?.rowspan && block.attributes.rowspan !== "1") {
                rendered.append(node(document, "small", "structure-note", `Saved row span: ${block.attributes.rowspan} · shown in row order`));
              }
            } else body.append(rendered);
          }
          cell.append(body);
          pair.append(cell);
        }
        return pair;
      };
      const changed = units.map((unit) => unit.rows.some((row) => row.kind !== "unchanged"));
      const visible = new Set();
      for (const [index, value] of changed.entries()) if (value) {
        for (let nearby = Math.max(0, index - 2); nearby <= Math.min(units.length - 1, index + 2); nearby++) visible.add(nearby);
      }
      if (!changes.length) {
        root.append(node(document, "p", "comparison-notice", "No changes detected in this comparison format."));
        for (let index = 0; index < Math.min(3, units.length); index++) visible.add(index);
      }
      for (let index = 0; index < units.length;) {
        if (visible.has(index)) { root.append(renderUnit(units[index++])); continue; }
        const start = index;
        while (index < units.length && !visible.has(index)) index++;
        const end = index;
        let next = start;
        const expand = node(document, "button", "comparison-expand");
        expand.type = "button";
        const update = () => {
          expand.textContent = `↕ Show ${Math.min(20, end - next)} of ${end - next} unchanged ${mode === "source" ? "lines" : "blocks"}`;
          expand.setAttribute("aria-label", expand.textContent);
        };
        update();
        expand.addEventListener("click", () => {
          const limit = Math.min(end, next + 20);
          while (next < limit) expand.before(renderUnit(units[next++]));
          if (next === end) {
            const previous = expand.previousElementSibling;
            previous.tabIndex = -1;
            previous.focus({ preventScroll: true });
            expand.remove();
          } else update();
        });
        root.append(expand);
      }
    },
    select(index, { scroll = false } = {}) {
      selected?.classList.remove("comparison-current");
      selected = targets.get(changes[index]?.id || `legacy-change-${index}`);
      selected?.classList.add("comparison-current");
      if (scroll && selected) selected.scrollIntoView({ block: "center", behavior: "instant" });
    },
  };
}
