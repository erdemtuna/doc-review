import test from "node:test";
import assert from "node:assert/strict";
import { createComposerDraft, createContextualController } from "../lib/contextual-controller.js";

function fixture() {
  const state = { open: true, disabled: false, submitting: false, kind: "text", quote: "Selected text", placement: "attached", draft: createComposerDraft() };
  const calls = [];
  const runtime = createContextualController({
    read: () => state,
    submit: () => calls.push("submit"), cancel: () => calls.push("cancel"),
    reveal: () => calls.push("reveal"), focus: () => calls.push("focus"), measure: () => calls.push("measure"),
  });
  return { state, runtime, calls };
}
test("contextual snapshot is cached and does not expose the mutable draft owner", () => {
  const { state, runtime } = fixture();
  const before = runtime.getSnapshot();
  assert.equal(runtime.getSnapshot(), before);
  runtime.commands.update({ text: "Retain draft", selectionStart: 2, selectionEnd: 5, composing: false });
  assert.equal(before.draft.text, "");
  assert.equal(state.draft.text, "Retain draft");
  assert.deepEqual(runtime.getSnapshot().draft, { ...state.draft });
  assert.notEqual(runtime.getSnapshot().draft, state.draft);
  assert.ok(Object.isFrozen(runtime.getSnapshot().draft));
});
test("contextual subscription cleanup leaves the session draft intact for remount", () => {
  const { state, runtime } = fixture();
  let count = 0;
  const unsubscribe = runtime.subscribe(() => count++);
  runtime.commands.update({ text: "Draft", selectionStart: 1, selectionEnd: 4, composing: false });
  unsubscribe();
  state.placement = "edge-top";
  runtime.publish();
  assert.equal(count, 1);
  assert.equal(runtime.getSnapshot().draft.text, "Draft");
  assert.deepEqual([runtime.getSnapshot().draft.selectionStart, runtime.getSnapshot().draft.selectionEnd], [1, 4]);
});
test("contextual commands reject closed, ended or comparing state and disposal", () => {
  for (const change of [(state) => { state.open = false; }, (state) => { state.disabled = true; }, (_, runtime) => runtime.dispose()]) {
    const { state, runtime, calls } = fixture();
    change(state, runtime);
    runtime.commands.submit(); runtime.commands.cancel(); runtime.commands.reveal(); runtime.commands.focus();
    runtime.commands.update({ text: "Lost", selectionStart: 0, selectionEnd: 0, composing: false });
    assert.deepEqual(calls, []);
    assert.equal(state.draft.text, "");
  }
});
test("pending composer stays read-only and cancellation cannot discard its draft", () => {
  const { state, runtime, calls } = fixture();
  state.draft.text = "In flight";
  state.submitting = true;
  runtime.commands.cancel();
  runtime.commands.update({ text: "Replacement", selectionStart: 0, selectionEnd: 0, composing: false });
  assert.equal(state.draft.text, "In flight");
  assert.deepEqual(calls, []);
});
test("composition blocks submission but delivery and retry remain runtime-owned", () => {
  const { state, runtime, calls } = fixture();
  state.draft.composing = true;
  runtime.commands.submit();
  assert.deepEqual(calls, []);
  state.draft.composing = false;
  state.draft.error = "Try again";
  state.draft.retry = true;
  runtime.publish();
  runtime.commands.submit();
  assert.deepEqual(calls, ["submit"]);
  assert.equal(runtime.getSnapshot().draft.error, "Try again");
});
