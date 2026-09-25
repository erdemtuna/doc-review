import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { fieldNotes, summaryFeedback, actionFeedback } from "../test/fixtures/readme-review.js";

export async function conversationSmoke({ browser, expect, project, state, evidenceDir, contracts, cliRun, connection, restart }) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage(), second = await context.newPage(), errors = [], evidence = [];
  for (const tab of [page, second]) tab.on("pageerror", (error) => errors.push(error.message));
  const refFor = (opened) => ({ reviewId: opened.review.reviewId, entryKey: opened.review.entryKey });
  const scopeArgs = (ref) => ["--review", ref.reviewId, "--entry", ref.entryKey];
  const cli = async (args, schema) => schema.parse(JSON.parse((await cliRun(args)).stdout));
  const open = (target) => cli([target, "--no-browser"], contracts.agentOpenSchema);
  const api = async (body, route = "/api/conversation") => {
    const { base, token } = connection();
    const result = await fetch(`${base}${route}`, {
      method: "POST", headers: { "content-type": "application/json", "x-doc-review-token": token },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
    });
    const value = await result.json();
    if (!result.ok) contracts.failureSchema.parse(value);
    return { status: result.status, value };
  };
  const ok = async (body, route) => {
    const result = await api(body, route);
    assert.equal(result.status, 200, JSON.stringify(result.value));
    return result.value;
  };
  const read = (ref, operation = "read-review", extra = {}) => ok({ operation, ...ref, ...extra });
  const mutate = async (ref, operation, extra = {}) => contracts.acceptedMutationSchema.parse(await ok({
    operation, ...ref, requestId: randomUUID(), expectedVersion: (await read(ref)).version, ...extra,
  })).receipt;
  const list = (ref, collection, fields = {}) => ok({ operation: "list", scope: {
    ...ref, collection, pageKey: null, threadId: null, submissionId: null, status: "all", ...fields,
  }, query: {} });
  const ready = (tab) => expect(tab.locator("#frame")).toHaveAttribute("data-sdk-ready", "true");
  const mode = async (tab, name) => {
    await tab.locator("#modeButton").click();
    await tab.getByRole("menuitemradio", { name: new RegExp(`^${name}`) }).click();
    await expect(tab.locator("#modeLabel")).toHaveText(name);
  };
  const editBlocked = async (tab, blocked) => {
    if (await tab.locator("#modeButton").isDisabled()) { assert.equal(blocked, true); return; }
    await tab.locator("#modeButton").click();
    const edit = tab.getByRole("menuitemradio", { name: /^Edit/ });
    if (blocked) await expect(edit).toBeDisabled();
    else await expect(edit).toBeEnabled();
    await tab.keyboard.press("Escape");
  };
  const threadAction = async (tab, thread, name) => {
    await thread.getByRole("button", { name: "Conversation actions" }).click();
    await tab.getByRole("menuitem", { name, exact: true }).click();
  };
  const feedback = async (tab) => {
    if (await tab.locator("#commentsButton").getAttribute("aria-expanded") !== "true") await tab.locator("#commentsButton").click();
  };
  const overallNote = async (tab) => {
    await feedback(tab);
    if (!await tab.getByRole("textbox", { name: "Overall note", exact: true }).isVisible()) {
      await tab.getByRole("button", { name: /Overall note \(optional\)/ }).click();
    }
  };
  const message = async (tab, body, change = false) => {
    await feedback(tab); await tab.getByRole("button", { name: "New message", exact: true }).click();
    const composer = tab.locator('[data-composer="new"]');
    await expect(composer.getByLabel("Request a change")).not.toBeChecked();
    await composer.getByRole("textbox").fill(body);
    if (change) await composer.getByLabel("Request a change").check();
    await composer.getByRole("button", { name: "Save", exact: true }).click();
    await expect(composer).toHaveCount(0);
  };
  const pick = (ref) => cli(["poll", ...scopeArgs(ref), "--timeout", "5"], contracts.agentPollSchema);
  const responseFor = (work, extra = {}) => contracts.completeResponseSchema.parse({
    operation: "respond", reviewId: work.reviewId, entryKey: work.entryKey,
    requestId: randomUUID(), submissionId: work.submissionId, expectedVersion: work.version,
    responses: work.messages.map(({ message }) => ({
      threadId: message.threadId, messageId: message.messageId, messageVersion: message.version,
      body: `Inline reply: ${message.body}`, outcome: "answered",
    })),
    editOutcomes: work.edits.map((edit) => ({ editId: edit.editId, editVersion: edit.version,
      outcome: edit.source.state === "saved" ? "already-saved" : "deferred", reason: "Exact human record retained." })),
    resultNote: "Answered without new source work.", ...(work.overallNote ? { overallOutcome: "answered" } : {}), ...extra,
  });
  const respond = async (ref, response) => {
    const file = path.join(project, "response.json"); fs.writeFileSync(file, JSON.stringify(response));
    return cli(["respond", ...scopeArgs(ref), "--response-file", file, "--timeout", "8"], contracts.acceptedMutationSchema);
  };
  const rejectResponse = async (ref, response, code) => {
    await assert.rejects(respond(ref, response), (error) => {
      const result = contracts.failureSchema.parse(JSON.parse(error.stdout));
      return error.code === 1 && result.error.code === code;
    });
  };
  const select = async (locator) => locator.evaluate((element) => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  const type = async (tab, selector, text) => {
    const element = tab.frameLocator("#frame").locator(selector);
    await element.click(); await select(element); await tab.keyboard.insertText(text);
  };
  const paste = async (tab, selector) => tab.frameLocator("#frame").locator(selector).evaluate((element) => {
    const range = document.createRange(); range.selectNodeContents(element); range.collapse(false);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), (char) => char.charCodeAt(0));
    const transfer = new DataTransfer(); transfer.items.add(new File([bytes], "image.png", { type: "image/png" }));
    element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }));
  });
  try {
    const target = path.join(project, "complete-loop.html");
    const original = '<!doctype html><html><head><style>body{max-width:600px;padding:24px}</style></head><body><h1>Installed conversation</h1><p id="copy">Original copy</p><p id="format">Alpha</p><p id="delete"><em>Delete exactly</em></p><p id="last">Gamma</p><p id="image">Image here</p><p id="agent">Agent target</p></body></html>';
    fs.writeFileSync(target, original);
    const opened = await open(target), ref = refFor(opened);
    assert.equal((await open(target)).review.reviewId, ref.reviewId, "second open joins the durable review");
    for (const tab of [page, second]) { await tab.goto(opened.url); await ready(tab); }
    await message(page, "Why this wording?");
    await feedback(second);
    await expect(second.getByText("Why this wording?", { exact: true })).toBeVisible();
    await page.locator("#send").click();
    await expect(page.getByText("Queued; not received", { exact: true })).toBeVisible();
    const first = (await pick(ref)).submission;
    assert.equal(first.messages[0].message.intent, "discuss");
    const contextPage = await cli(["context", ...scopeArgs(ref), "--thread", first.messages[0].message.threadId], contracts.contextPageSchema);
    assert.equal(contextPage.items[0].reviewer.body, "Why this wording?");
    const firstFrame = await page.locator("#frame").getAttribute("src");
    await respond(ref, responseFor(first, { resultNote: "Discussion left every source byte unchanged." }));
    await expect(page.locator(".conversation-result-preview")).toHaveText("Discussion left every source byte unchanged.");
    assert.equal(fs.readFileSync(target, "utf8"), original);
    assert.equal(await page.locator("#frame").getAttribute("src"), firstFrame, "reply-only response creates no fake version");
    evidence.push({ phase: "discussion", reviewId: ref.reviewId, submissionId: first.submissionId, unchanged: true });

    await page.getByRole("complementary", { name: "Feedback" }).getByRole("button", { name: "Close", exact: true }).click();
    await mode(page, "Edit");
    await type(page, "#copy", "Exact human wording");
    await expect.poll(() => fs.readFileSync(target, "utf8")).toContain("Exact human wording");
    await type(page, "#copy", "Exact repeated human wording");
    await expect.poll(() => fs.readFileSync(target, "utf8")).toContain("Exact repeated human wording");
    const frame = page.frameLocator("#frame");
    await frame.locator("#format").click(); await select(frame.locator("#format")); await page.keyboard.press("Control+b");
    await expect.poll(() => fs.readFileSync(target, "utf8")).toMatch(/<(b|strong)>Alpha/);
    await frame.locator("#format").evaluate(() => new Promise(resolve => {
      document.addEventListener("selectionchange", () => resolve(), { once: true });
      getSelection().removeAllRanges();
    }));
    await frame.locator("#last").hover(); await frame.locator("#format").hover({ position: { x: 20, y: 8 } });
    await expect(frame.locator("#mover")).toBeVisible();
    await expect.poll(async () => {
      const handle = await frame.locator("#mover").boundingBox(), target = await frame.locator("#format").boundingBox();
      return handle && handle.y - target.y;
    }).toBe(1);
    const mover = await frame.locator("#mover").boundingBox(), destination = await frame.locator("#last").boundingBox();
    assert.ok(mover && destination);
    await page.mouse.move(mover.x + mover.width / 2, mover.y + mover.height / 2); await page.mouse.down();
    await page.mouse.move(destination.x + 40, destination.y + destination.height - 2, { steps: 10 }); await page.mouse.up();
    await expect.poll(() => fs.readFileSync(target, "utf8")).toMatch(/Gamma.*Alpha/s);
    await frame.locator("#delete").hover(); await frame.locator("#chipDelete").click();
    await expect.poll(() => fs.readFileSync(target, "utf8")).not.toContain("Delete exactly");
    await frame.locator("#image").click(); await paste(page, "#image");
    await expect.poll(() => fs.readFileSync(target, "utf8")).toContain("assets/paste_");
    await mode(page, "View");
    await message(page, "Clarify without changing more source.");
    await message(page, "Change only the Agent target paragraph.", true);
    await page.locator("#send").click(); await expect(page.getByText("Queued; not received", { exact: true })).toBeVisible();
    const mixed = (await pick(ref)).submission;
    assert.deepEqual(new Set(mixed.messages.map(({ message }) => message.intent)), new Set(["discuss", "request-change"]));
    assert.deepEqual(new Set(mixed.edits.map(({ content }) => content.kind)), new Set(["edited", "moved", "deleted"]));
    assert.ok(mixed.edits.every((edit) => edit.source.state === "saved"));
    assert.ok(mixed.edits.some((edit) => edit.content.after === "Exact repeated human wording"));
    assert.ok(mixed.edits.some((edit) => edit.content.before_html?.includes("<em>Delete exactly</em>")));
    const staged = mixed.edits.flatMap((edit) => edit.assets);
    assert.equal(staged.length, 1); assert.ok(fs.existsSync(staged[0].path));
    const beforeAgent = fs.readFileSync(target, "utf8");
    const response = responseFor(mixed, { resultNote: "Kept exact human edits; changed only the checked request." });
    response.responses.find((reply) => mixed.messages.find(({ message }) => message.messageId === reply.messageId).message.intent === "request-change").outcome = "applied";
    await rejectResponse(ref, { ...response, requestId: "missing-coverage", responses: [] }, "RESPONSE_COVERAGE");
    await rejectResponse(ref, { ...response, requestId: "duplicate-coverage", responses: [response.responses[0], response.responses[0]] }, "RESPONSE_COVERAGE");
    await rejectResponse(ref, { ...response, requestId: "wrong-scope", reviewId: "another-review" }, "SCOPE_MISMATCH");
    assert.deepEqual((await pick(ref)).submission, mixed, "rejected responses publish no partial handling");
    fs.writeFileSync(target, beforeAgent.replace("Agent target", "Agent changed only this target"));
    const exactAfterAgent = fs.readFileSync(target, "utf8");

    const recordPath = path.join(state, "server.json"), recordBytes = fs.readFileSync(recordPath, "utf8");
    const attempts = [];
    const proxy = http.createServer(async (request, result) => {
      try {
        const chunks = []; for await (const chunk of request) chunks.push(chunk);
        const body = Buffer.concat(chunks).toString(), current = connection();
        const upstream = await fetch(`${current.base}${request.url}`, {
          method: request.method, headers: { "content-type": "application/json", "x-doc-review-token": current.token },
          ...(body ? { body } : {}),
        });
        const text = await upstream.text();
        if (body && JSON.parse(body).operation === "respond") {
          attempts.push(body);
          if (attempts.length === 1) { result.destroy(); return; }
        }
        result.writeHead(upstream.status, { "content-type": "application/json" }); result.end(text);
      } catch (error) { result.destroy(error); }
    });
    await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    let accepted;
    try {
      fs.writeFileSync(recordPath, JSON.stringify({ ...JSON.parse(recordBytes), port: proxy.address().port }));
      accepted = await respond(ref, response);
      assert.ok(attempts.length >= 1);
      assert.ok(attempts.every((body) => body === JSON.stringify(response)));
    } finally {
      fs.writeFileSync(recordPath, recordBytes);
      proxy.closeAllConnections(); await new Promise((resolve) => proxy.close(resolve));
    }
    assert.deepEqual(await respond(ref, response), accepted);
    assert.equal(fs.readFileSync(target, "utf8"), exactAfterAgent, "transport retry never repeats source edits");
    await expect(page.locator(".conversation-result-preview")).toHaveText(response.resultNote);
    await expect(second.locator(".conversation-result-preview")).toHaveText(response.resultNote);
    assert.equal((await read(ref, "submission", { submissionId: mixed.submissionId })).result.responses.length, mixed.messages.length);
    evidence.push({ phase: "mixed", submissionId: mixed.submissionId, savedEdits: mixed.edits.length,
      responseAttempts: attempts.length, receipt: accepted.receipt.requestId, sourceWrittenOnce: true });

    const thread = page.locator(`[data-thread="${first.messages[0].message.threadId}"]`);
    await threadAction(page, thread, "Resolve");
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    await threadAction(page, thread, "Reopen");
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    await thread.getByRole("button", { name: "Conversation actions" }).click();
    await expect(page.getByRole("menuitem", { name: "Resolve", exact: true })).toBeEnabled();
    await page.keyboard.press("Escape");
    const lost = new Map();
    await page.route("**/api/conversation", async (route) => {
      const body = route.request().postDataJSON();
      if (["send", "end"].includes(body.operation) && !lost.has(body.operation)) {
        lost.set(body.operation, body); await route.fetch(); await route.abort("connectionreset");
      } else await route.continue();
    });
    await overallNote(page);
    const note = page.getByRole("textbox", { name: "Overall note", exact: true });
    await note.fill("Late explanation only.");
    await expect(page.locator('[data-composer="note"]').getByLabel("Request a change")).not.toBeChecked();
    await page.locator("#send").click();
    await expect(page.getByText("send: acceptance unknown", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Check receipt", exact: true }).click();
    await expect(page.getByText("send: acceptance unknown", { exact: true })).toHaveCount(0);
    const outstanding = (await pick(ref)).submission;
    await message(page, "Saved unsent stays in the old review.");
    await note.fill("This local draft must not be recovered after restart.");
    await page.locator("#endReview").click();
    await expect(page.getByRole("alertdialog")).toContainText("for every tab");
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(page.getByRole("alertdialog")).toContainText("Acceptance is unknown");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("button", { name: "Check receipt", exact: true }).click();
    for (const tab of [page, second]) await expect(tab.locator(".conversation-lifecycle")).toHaveText("Review ended");
    await expect(page.getByText("Saved unsent · read-only", { exact: true })).toBeVisible();
    await page.unroute("**/api/conversation");
    const oldUrl = page.url();
    await restart();
    await page.goto(oldUrl); await ready(page); await feedback(page);
    await expect(page.locator(".conversation-lifecycle")).toHaveText("Review ended");
    await overallNote(page);
    await expect(page.getByRole("textbox", { name: "Overall note", exact: true })).toHaveValue("");
    await expect(page.getByText("Saved unsent stays in the old review.", { exact: true })).toBeVisible();
    const fresh = await open(target), freshRef = refFor(fresh);
    assert.notEqual(freshRef.reviewId, ref.reviewId);
    await second.goto(fresh.url); await ready(second); await feedback(second);
    await editBlocked(second, true);
    assert.equal((await list(freshRef, "threads")).totalCount, 0);
    await respond(ref, responseFor(outstanding, { resultNote: "Valid late result after shared End and restart." }));
    await expect(page.locator(".conversation-result-preview")).toHaveText("Valid late result after shared End and restart.");
    await editBlocked(second, false);
    assert.equal((await list(freshRef, "history")).totalCount, 0);
    assert.deepEqual(fs.readFileSync(staged[0].path), fs.readFileSync(path.join(project, "assets", staged[0].id)));
    evidence.push({ phase: "late-restart", ended: ref.reviewId, fresh: freshRef.reviewId,
      submissionId: outstanding.submissionId, unsentRetained: true, localDraftRecovered: false });
    for (const theme of ["light", "dark"]) {
      if (await page.locator("html").getAttribute("data-theme") !== theme) await page.locator("#theme").click();
      await page.screenshot({ path: path.join(evidenceDir, `installed-ended-${theme}.png`), animations: "disabled", caret: "initial" });
    }

    for (const kind of ["markdown", "scripted", "url"]) {
      const source = path.join(project, kind === "markdown" ? "source.md" : `${kind}-source.html`);
      const bytes = kind === "markdown" ? "# Source\n\nOriginal pending text\n"
        : `<html><body><p id="pending">Original pending text</p>${kind === "scripted" ? "<script>window.fixture=true</script>" : ""}</body></html>`;
      fs.writeFileSync(source, bytes);
      let app;
      try {
        if (kind === "url") {
          app = http.createServer((_request, result) => {
            result.writeHead(200, { "content-type": "text/html" }); result.end(fs.readFileSync(source));
          });
          await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
        }
        const opened = await open(app ? `http://127.0.0.1:${app.address().port}/review` : source), pendingRef = refFor(opened);
        await second.goto(opened.url); await ready(second);
        await mode(second, "Edit");
        await type(second, "p", `Exact ${kind} source edit`);
        await feedback(second); await expect(second.getByText("Source pending", { exact: true })).toHaveCount(1);
        await second.locator("#send").click(); await expect(second.getByText("Queued; not received", { exact: true })).toBeVisible();
        const work = (await pick(pendingRef)).submission;
        assert.equal(work.edits[0].source.state, "pending");
        assert.equal(fs.readFileSync(source, "utf8"), bytes, "rendered output never replaces source");
        const after = bytes.replace("Original pending text", work.edits[0].content.after);
        fs.writeFileSync(source, after);
        const complete = responseFor(work, { resultNote: `Applied exact human edit to identified ${kind} source.` });
        complete.editOutcomes[0].outcome = "applied";
        await respond(pendingRef, complete);
        assert.equal(fs.readFileSync(source, "utf8"), after);
        await expect(second.locator(".conversation-result-preview")).toHaveText(complete.resultNote);
        evidence.push({ phase: "source-pending", kind, source: path.basename(source), submissionId: work.submissionId });
      } finally {
        if (app) { app.closeAllConnections(); await new Promise((resolve) => app.close(resolve)); }
      }
    }
    const shared = path.join(project, "shared-target.html");
    fs.writeFileSync(shared, "<p>Shared source</p>");
    const independentA = refFor(await open(path.join(project, "source.md")));
    const entryB = path.join(project, "independent.html"); fs.writeFileSync(entryB, "<p>Independent entry</p>");
    const independentB = refFor(await open(entryB));
    const sharedKey = (await mutate(independentA, "join-page", { target: shared })).value.pageKey;
    await mutate(independentB, "join-page", { target: shared });
    const noteSend = (ref, pageKeys, body) => mutate(ref, "send", {
      pageKeys, messages: [], edits: [], overallNote: { body, intent: "discuss" },
    });
    const blocked = await noteSend(independentA, [sharedKey], "Read this shared source");
    await mutate(independentA, "end", { confirmUnsentReadOnly: true });
    for (const operation of ["send", "record-edit", "save-edit", "revert"]) {
      const edit = { kind: "edited", label: "Shared source", before: "Shared source", after: "Prohibited",
        before_html: "<p>Shared source</p>", after_html: "<p>Prohibited</p>", truncated: false, truncated_fields: [], staged_assets: [] };
      const fields = operation === "send" ? { pageKeys: [sharedKey], messages: [], edits: [], overallNote: { body: "Overlap", intent: "discuss" } }
        : operation === "record-edit" ? { pageKey: sharedKey, content: edit }
          : operation === "save-edit" ? { pageKey: sharedKey, editId: "absent", editVersion: 1, expectedSourceHash: "stale", html: "<p>Prohibited</p>" }
            : { pageKey: sharedKey, expectedSourceHash: "stale", baselineRevisionId: "absent" };
      const refused = await api({ operation, ...independentB, requestId: randomUUID(), expectedVersion: (await read(independentB)).version, ...fields });
      assert.equal(refused.status, 409);
      assert.equal(refused.value.error.code, "WORK_OUTSTANDING");
    }
    assert.equal(fs.readFileSync(shared, "utf8"), "<p>Shared source</p>");
    const blockedWork = (await pick(independentA)).submission;
    await mutate(independentA, "abandon", { expectedVersion: blockedWork.version, submissionId: blockedWork.submissionId,
      reason: "Stopped the cooperating fixture handler and checked source.", confirmExternalWorkMayContinue: true });
    await rejectResponse(independentA, responseFor(blockedWork), "SUBMISSION_ABANDONED");
    assert.equal((await read(independentA, "poll")).state, "ended");
    await noteSend(independentB, [sharedKey], "Independent entry now unblocked");
    const finished = (await pick(independentB)).submission;
    await respond(independentB, responseFor(finished));
    const tooLate = await api({ operation: "abandon", ...independentB, requestId: randomUUID(),
      expectedVersion: finished.version, submissionId: finished.submissionId, reason: "Too late", confirmExternalWorkMayContinue: true });
    assert.equal(tooLate.value.error.code, "ALREADY_HANDLED");
    await noteSend(independentB, [sharedKey], "Abandon while still open");
    const openWork = (await pick(independentB)).submission;
    await mutate(independentB, "abandon", { expectedVersion: openWork.version, submissionId: openWork.submissionId,
      reason: "Checked source before releasing work.", confirmExternalWorkMayContinue: true });
    await rejectResponse(independentB, responseFor(openWork), "SUBMISSION_ABANDONED");
    evidence.push({ phase: "overlap-and-terminal-races", sharedKey, blockedSubmission: blocked.value.submissionId,
      independentEntries: [independentA.entryKey, independentB.entryKey], blockedWrites: true, abandonmentOpenAndEnded: true,
      completionFirst: true, abandonmentFirst: true });

    const unavailableFile = path.join(project, "unavailable.html"); fs.writeFileSync(unavailableFile, "<p>Before capture failure</p>");
    const unavailable = await open(unavailableFile), unavailableRef = refFor(unavailable);
    await second.goto(unavailable.url); await ready(second);
    await second.route("**/api/conversation/capture", (route) => route.fulfill({ status: 409,
      json: contracts.contractFailure(new contracts.ContractError("VERSION_CONFLICT", "Fixture capture unavailable")) }));
    await overallNote(second);
    await second.getByRole("textbox", { name: "Overall note" }).fill("Change identified source");
    await second.locator('[data-composer="note"]').getByLabel("Request a change").check();
    await second.locator("#send").click(); await expect(second.getByText("Queued; not received", { exact: true })).toBeVisible();
    const noCapture = (await pick(unavailableRef)).submission;
    fs.writeFileSync(unavailableFile, "<p>After capture failure</p>");
    await respond(unavailableRef, responseFor(noCapture, { overallOutcome: "applied", resultNote: "Handled despite unavailable capture." }));
    await expect(second.locator(".conversation-result-preview")).toHaveText("Handled despite unavailable capture.");
    const sourceComparison = await ok({ ...unavailableRef, submissionId: noCapture.submissionId, pageKey: unavailableRef.entryKey, mode: "source" }, "/api/conversation/comparison");
    assert.equal(sourceComparison.available, true);
    await second.unroute("**/api/conversation/capture");
    evidence.push({ phase: "capture-independent", submissionId: noCapture.submissionId, sourceAvailable: true });

    const anchorsFile = path.join(project, "anchors.html");
    fs.writeFileSync(anchorsFile, "<style>body{max-width:500px;padding:24px}</style><p>Unique installed target</p><p>Repeated target</p><p>Repeated target</p>");
    const anchored = await open(anchorsFile), anchorRef = refFor(anchored);
    const anchorIds = [];
    for (const quote of ["Unique installed target", "Repeated target", "Missing target"]) {
      anchorIds.push((await mutate(anchorRef, "create-thread", { pageKey: anchorRef.entryKey,
        target: { kind: "selection", anchor: { quote } }, body: `Discuss ${quote}`, intent: "discuss" })).value.threadId);
    }
    await second.goto(anchored.url); await ready(second); await feedback(second);
    const active = second.locator(`[data-thread="${anchorIds[0]}"]`);
    await active.getByRole("button", { name: "Reply", exact: true }).click();
    const editor = active.getByRole("textbox", { name: "Reply", exact: true });
    await editor.fill("Keep one installed editor");
    await editor.evaluate((node) => { window.installedEditor = node; node.setSelectionRange(2, 8); node.dispatchEvent(new Event("select", { bubbles: true })); });
    await active.getByRole("button", { name: "Focus", exact: true }).click();
    await threadAction(second, active, "Beside target");
    assert.deepEqual(await editor.evaluate((node) => [node === window.installedEditor, node.selectionStart, node.selectionEnd]), [true, 2, 8]);
    await expect(second.getByRole("textbox", { name: "Reply", exact: true })).toHaveCount(1);
    await threadAction(second, active, "Back to Feedback");
    for (const id of anchorIds.slice(1)) {
      const item = second.locator(`[data-thread="${id}"]`);
      await expect(item.getByRole("button", { name: "Jump to", exact: true })).toBeDisabled();
      await expect(item.getByRole("button", { name: "Reply", exact: true })).toBeEnabled();
    }
    await second.screenshot({ path: path.join(evidenceDir, "installed-target-safety.png"), animations: "disabled", caret: "initial" });
    evidence.push({ phase: "target-safety", missingAndAmbiguous: true, oneEditor: true });
    const retainedQuery = { ...ref, submissionId: mixed.submissionId, pageKey: ref.entryKey, mode: "source" };
    const retained = await ok(retainedQuery, "/api/conversation/comparison");
    assert.equal(retained.available, true);
    for (let index = 0; index < 6; index++) {
      await noteSend(freshRef, [freshRef.entryKey], `Retained-history discussion ${index + 1}`);
      const later = (await pick(freshRef)).submission;
      await respond(freshRef, responseFor(later));
    }
    await restart();
    assert.deepEqual(await ok(retainedQuery, "/api/conversation/comparison"), retained);
    assert.deepEqual(fs.readFileSync(staged[0].path), fs.readFileSync(path.join(project, "assets", staged[0].id)));
    assert.equal((await list(freshRef, "history")).totalCount, 6);
    assert.equal((await read(ref)).state, "ended");
    evidence.push({ phase: "retention", laterSubmissions: 6, endedSnapshotUnchanged: true, stagedAndSourceAssetsRetained: true, restarted: true });
    const previewTarget = path.join(project, "approved-field-notes.html");
    fs.writeFileSync(previewTarget, fieldNotes());
    const preview = await open(previewTarget), previewRef = refFor(preview);
    for (const [selector, label, body] of [["#summary", "Summary", summaryFeedback], ["#action", "Call to action", actionFeedback]]) {
      await mutate(previewRef, "create-thread", { pageKey: previewRef.entryKey,
        target: { kind: "element", anchor: { selector, label } }, body, intent: "discuss" });
    }
    fs.writeFileSync(path.join(evidenceDir, "preview-fixture.json"), JSON.stringify({
      project, state, target: previewTarget, ...previewRef, path: `/r/${previewRef.reviewId}`,
      changed: { target, ...ref, path: `/r/${ref.reviewId}`, submissionId: mixed.submissionId },
    }, null, 2));
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(evidenceDir, "conversation-loop.json"), JSON.stringify(evidence, null, 2));
  } catch (error) {
    await page.screenshot({ path: path.join(evidenceDir, "conversation-failure.png"), animations: "disabled", caret: "initial" });
    fs.writeFileSync(path.join(evidenceDir, "conversation-progress.json"), JSON.stringify({ evidence, errors }, null, 2));
    throw error;
  } finally { await context.close(); }
}
