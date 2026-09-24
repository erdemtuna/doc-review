import {
  frameAnchorsSchema, frameAnchorStatesSchema, frameThreadActionSchema,
  isCurrentFrameProjection, sameFrameAnchorProjection, validateFrameAnchorStates, validateFrameThreadAction,
  type FrameThreadAnchors, type FrameThreadAnchorStates, type FrameThreadAction,
} from "./contracts/frame.js";
import { reject } from "./contracts/validation.js";
import { sameThreadTarget } from "./comment-target.js";

export type ConversationAnchorState = FrameThreadAnchorStates["anchors"][number];
export function describeConversationAnchor(state?: ConversationAnchorState) {
  if (!state) return { canJump: false, offscreen: false, reason: "Checking the target in the current render." };
  if (state.state === "found") return {
    canJump: true, offscreen: state.relation !== "visible",
    reason: state.relation === "visible" ? "" : "The target is offscreen, not missing. Use Back to target.",
  };
  const reason = state.state === "missing" ? "The original target was not found. The conversation is still available."
    : state.state === "ambiguous" ? "Multiple targets match. No highlight or jump was chosen."
      : ({
        hidden: "The target is hidden. Reveal it in the document before showing it.",
        "not-measurable": "The target cannot currently be measured.",
        "invalid-selector": "The original element selector is unavailable in this render.",
        "render-loading": "The document is still loading; target availability is not known.",
        "render-changed": "The render or element identity changed. No replacement target was chosen.",
        "render-unavailable": "The document render is unavailable; this does not mean the source target is missing.",
      }[state.reason]);
  return { canJump: false, offscreen: false, reason };
}

/** Shell-side geometry only; the conversation owner retains all user state. */
export function createConversationAnchorController() {
  let projection: FrameThreadAnchors | null = null;
  let states: ConversationAnchorState[] = [];
  let revision = 0;
  return {
    get projection() { return projection; },
    get states() { return states; },
    reset() { projection = null; states = []; },
    project(input: Omit<FrameThreadAnchors, "projectionRevision">) {
      const next = frameAnchorsSchema.parse({ ...input, projectionRevision: revision + 1 });
      if (projection && sameFrameAnchorProjection(next, projection)) return false;
      const sameRender = projection && ["capability", "reviewId", "pageKey", "renderId", "generation"].every((key) =>
        projection![key as keyof FrameThreadAnchors] === next[key as keyof FrameThreadAnchors]);
      states = sameRender ? states.filter((state) => next.anchors.some((anchor) => anchor.threadId === state.threadId &&
        JSON.stringify(anchor) === JSON.stringify(projection!.anchors.find((previous) => previous.threadId === state.threadId)))) : [];
      projection = next;
      revision = next.projectionRevision;
      return true;
    },
    receive(input: unknown) {
      if (!projection) return reject("SCOPE_MISMATCH", "No current conversation projection.");
      const report = frameAnchorStatesSchema.parse(input);
      if (!isCurrentFrameProjection(report, projection)) return false;
      states = validateFrameAnchorStates(report, projection).anchors;
      return true;
    },
    incoming(input: unknown) {
      if (!projection) return reject("SCOPE_MISMATCH", "No current conversation projection.");
      const action = frameThreadActionSchema.parse(input);
      if (action.action === "reveal") reject("INVALID_INPUT", "Only the shell may request target reveal.");
      if (!isCurrentFrameProjection(action, projection)) return null;
      validateFrameThreadAction(action, projection);
      if (action.action === "activate" && !states.some((state) => state.threadId === action.threadId && state.state === "found")) {
        reject("INVALID_INPUT", "Activation requires a currently verified target.");
      }
      return action;
    },
    outgoing(action: FrameThreadAction["action"], threadId: string) {
      if (!projection) return reject("SCOPE_MISMATCH", "No current conversation projection.");
      if (action !== "dismiss" && !states.some((state) => state.threadId === threadId && state.state === "found")) {
        reject("INVALID_INPUT", "Target is not currently available. Continue in Feedback.");
      }
      const { anchors: _anchors, ...scope } = projection;
      return validateFrameThreadAction({ ...scope, type: "eh:threadAction", action, threadId }, projection);
    },
    peers(threadId: string) {
      const own = states.find((state) => state.threadId === threadId);
      if (own?.state !== "found") return [threadId];
      return states.filter((state) => sameThreadTarget(state, own))
        .map((state) => state.threadId);
    },
  };
}
