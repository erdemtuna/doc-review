import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture, responseFor, scopeArgs } from "./fixtures/agent-loop.js";
import * as c from "../lib/contracts/index.js";
import { AGENT_INSTRUCTIONS, agentHandoff } from "../lib/agent-handoff.js";

test("shell handoff text retires acknowledgement and blanket edits without adding a duplicate timeout", () => {
  const handoff = agentHandoff({ reviewId: "review", entryKey: "entry" });
  assert.match(handoff.pollCommand, /--review review --entry entry/);
  assert.equal(handoff.pollCommand.match(/--timeout/g)?.length, 1);
  assert.match(AGENT_INSTRUCTIONS, /complete template/);
  assert.match(AGENT_INSTRUCTIONS, /same response file\/request, not source edits/);
  assert.doesNotMatch(JSON.stringify(handoff), /--ack|apply the feedback/);
  assert.equal(fs.existsSync(new URL("../src/chrome-client.js", import.meta.url)), false);
});

test("open/session/shell handoffs bind generated executable commands to the durable review", async (t) => {
  const f = await fixture(t), file = f.file();
  const first = await f.cli(file, "--request-id", "repeatable-open", "--no-browser");
  assert.equal(first.code, 0, first.stderr);
  const opened = c.agentOpenSchema.parse(first.body);
  const ref = { reviewId: opened.review.reviewId, entryKey: opened.review.entryKey };
  assert.equal((await f.open(file)).review.reviewId, ref.reviewId);
  const attached = await f.ok({ operation: "read-review", ...ref }, "/api/conversation/session");
  const page = await fetch(`http://127.0.0.1:${f.server.port}/api/session/${attached.sessionId}/page`, {
    headers: { "x-doc-review-token": f.server.token },
  });
  const bootstrap = await page.json();
  assert.ok(JSON.stringify(bootstrap).includes(`--review ${ref.reviewId} --entry ${ref.entryKey}`));
  await f.send(ref, [await f.thread(ref)]);
  const run = f.run;
  const polled = await run(opened.handoff.pollCommand);
  assert.equal(polled.code, 0, polled.stderr);
  const work = c.agentPollSchema.parse(polled.body);
  const handoff = work.submission.handoff;
  const context = await run(work.submission.inventory.items.find((item) => item.kind === "message").contextCommand);
  assert.equal(context.code, 0, context.stderr);
  c.agentContextSchema.parse(context.body);
  assert.equal(context.body.totalCount, 0, "current message is not history");
  const template = await run(handoff.templateCommand);
  assert.equal(template.code, 0, template.stderr);
  const blank = JSON.parse(fs.readFileSync(template.body.path, "utf8"));
  assert.throws(() => c.completeResponseSchema.parse(blank));
  fs.writeFileSync(template.body.path, JSON.stringify({ ...responseFor(work.submission), requestId: blank.requestId }));
  const response = await run(handoff.responseCommand);
  assert.equal(response.code, 0, response.stderr);
  c.acceptedMutationSchema.parse(response.body);
  const status = await run(handoff.statusCommand);
  assert.equal(status.code, 0, status.stderr);
  c.agentStatusSchema.parse(status.body);
  await f.mutate(ref, "end", { confirmUnsentReadOnly: true });
  const fresh = await f.open(file);
  assert.notEqual(fresh.review.reviewId, ref.reviewId);
  const replay = await f.cli(file, "--request-id", "repeatable-open", "--no-browser");
  assert.equal(replay.body.review.reviewId, ref.reviewId, "exact open replay does not attach fresh review");
  assert.equal(replay.body.review.state, "ended");
  assert.equal((await run(handoff.pollCommand)).body.state, "ended");
});

test("CLI context pages include only earlier submitted exchanges across restart and pending writes", async (t) => {
  const f = await fixture(t), opened = await f.open(f.file());
  const ref = { reviewId: opened.review.reviewId, entryKey: opened.review.entryKey };
  const initial = await f.thread(ref);
  const messages = [initial];
  for (let i = 0; i < 104; i++) messages.push(await f.mutate(ref, "reply", {
    threadId: initial.value.threadId, body: `Context ${i}`, intent: "discuss",
  }));
  await f.send(ref, messages.slice().reverse());
  await f.poll(ref);
  const sent = (await f.read(ref, "poll")).submission;
  assert.equal((await f.respond(ref, responseFor(sent))).code, 0);
  const followup = await f.mutate(ref, "reply", { threadId: initial.value.threadId, body: "Followup", intent: "discuss" });
  await f.send(ref, [followup]);
  const current = (await f.poll(ref)).submission;
  const args = ["context", ...scopeArgs(ref), "--submission", current.submissionId, "--thread", initial.value.threadId];
  const latest = await f.cli(...args);
  assert.equal(latest.code, 0, latest.stderr);
  c.agentContextSchema.parse(latest.body);
  assert.equal(latest.body.items[0].body.text, "Context 103", "immutable sequence, not Send selection order, determines nearest exchange");
  assert.ok(latest.body.items.length <= 50);
  assert.equal(latest.body.totalCount, 105);
  await f.mutate(ref, "reply", { threadId: initial.value.threadId, body: "After cursor", intent: "discuss" });
  await f.restart();
  const items = [...latest.body.items];
  let next = latest.body.nextCursor;
  while (next) {
    const older = await f.cli(...args, "--limit", "100", "--cursor", next);
    assert.equal(older.code, 0, older.stderr);
    assert.ok(Buffer.byteLength(older.stdout) <= 16384);
    items.push(...older.body.items); next = older.body.nextCursor;
  }
  const ids = items.map((item) => item.messageId);
  assert.equal(new Set(ids).size, 105);
  const other = await f.thread(ref);
  const wrong = await f.cli("context", ...scopeArgs(ref), "--submission", current.submissionId, "--thread", other.value.threadId, "--cursor", latest.body.nextCursor);
  assert.equal(wrong.code, 1);
  assert.equal(wrong.body.error.code, "SCOPE_MISMATCH");
  assert.equal((await f.cli(...args, "--limit", "101")).body.error.code, "INVALID_INPUT");
});
