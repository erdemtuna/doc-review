import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { acceptedMutationSchema, failureSchema } from "../../lib/contracts/index.js";

export async function request(review, body, route = "/api/conversation") {
  const response = await fetch(`http://127.0.0.1:${review.port}${route}`, {
    method: "POST",
    headers: { "x-doc-review-token": review.token, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) failureSchema.parse(value);
  return { status: response.status, body: value };
}

export async function read(review, reference, operation = "read-review", fields = {}) {
  const { reviewId, entryKey } = reference;
  const result = await request(review, { operation, reviewId, entryKey, ...fields });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
}

export async function mutate(review, reference, operation, fields = {}) {
  return acceptedMutationSchema.parse(await read(review, reference, operation, {
    requestId: randomUUID(), expectedVersion: (await read(review, reference)).version, ...fields,
  })).receipt;
}

export async function openResponse(review, target) {
  const result = await request(review, { operation: "open", requestId: randomUUID(), target });
  if (result.status !== 200) return { ...result, raw: JSON.stringify(result.body) };
  const { receipt } = acceptedMutationSchema.parse(result.body);
  const ref = { reviewId: receipt.reviewId, entryKey: receipt.entryKey };
  const session = await request(review, { operation: "read-review", ...ref }, "/api/conversation/session");
  const body = session.status === 200 ? { ...ref, ...session.body, key: ref.entryKey } : session.body;
  return { status: session.status, body, raw: JSON.stringify(body) };
}

export async function openReview(review, target) {
  const result = await openResponse(review, target);
  assert.equal(result.status, 200, result.raw);
  return result.body;
}

export async function list(review, reference, collection, scope = {}, query = {}) {
  const result = await request(review, {
    operation: "list",
    scope: { reviewId: reference.reviewId, entryKey: reference.entryKey, collection,
      pageKey: null, threadId: null, submissionId: null, status: "all", ...scope },
    query,
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
}

export const content = (before, after, extra = {}) => ({
  label: "Paragraph", kind: "edited", before, after,
  before_html: `<p>${before}</p>`, after_html: `<p>${after}</p>`,
  truncated: false, truncated_fields: [], staged_assets: [], ...extra,
});

export function thread(review, reference, fields = {}) {
  return mutate(review, reference, "create-thread", {
    pageKey: reference.entryKey, target: { kind: "selection", anchor: { quote: "Original", prefix: "", suffix: "" } },
    body: "Why this wording?", intent: "discuss", ...fields,
  });
}

export function send(review, reference, messages = [], edits = [], fields = {}) {
  return mutate(review, reference, "send", {
    pageKeys: [reference.entryKey],
    messages: messages.map(({ value }) => ({ threadId: value.threadId, messageId: value.messageId, version: 1 })),
    edits, ...fields,
  });
}
