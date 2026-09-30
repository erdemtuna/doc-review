import {
  frameAnchorsSchema, sameFrameAnchorProjection, validateFrameAnchorStates, validateFrameThreadAction,
  type FrameIdentity, type FrameThreadAnchors, type FrameThreadAnchorStates,
} from "./contracts/frame.js";
import { reject } from "./contracts/validation.js";

type Anchor = FrameThreadAnchors["anchors"][number];
type State = FrameThreadAnchorStates["anchors"][number];
interface Options {
  channel: FrameIdentity;
  resolve(anchor: Anchor): State;
  reconcile?(projection: FrameThreadAnchors, states: FrameThreadAnchorStates): void;
  changed(projection: FrameThreadAnchors, states: FrameThreadAnchorStates): void;
}

/** Frame-local metadata only. The shell separately validates every report/action. */
export function createThreadAnchorController(options: Options) {
  let projection: FrameThreadAnchors | null = null;
  let signature = "";
  function measure(current: FrameThreadAnchors) {
    return validateFrameAnchorStates({
      ...current, type: "eh:threadAnchorStates",
      anchors: current.anchors.map(options.resolve),
    }, current);
  }
  function publish(states: FrameThreadAnchorStates) {
    options.reconcile?.(projection!, states);
    const next = JSON.stringify(states);
    if (signature !== next) {
      options.changed(projection!, states);
      signature = next;
    }
    return states;
  }
  function refresh() {
    return projection ? publish(measure(projection)) : null;
  }
  return {
    get projection() { return projection; },
    refresh,
    project(input: unknown) {
      const next = frameAnchorsSchema.parse(input);
      if (next.capability !== options.channel.capability || next.generation !== options.channel.generation ||
          next.pageKey !== options.channel.pageKey || (projection &&
          (next.reviewId !== projection.reviewId || next.renderId !== projection.renderId))) {
        reject("SCOPE_MISMATCH", "Projection does not belong to this bound frame.");
      }
      if (projection && (next.projectionRevision < projection.projectionRevision ||
          (next.projectionRevision === projection.projectionRevision && !sameFrameAnchorProjection(next, projection)))) {
        reject("SCOPE_MISMATCH", "Stale or reused anchor projection revision.");
      }
      const states = measure(next);
      projection = next;
      signature = "";
      return publish(states);
    },
    action(input: unknown) {
      if (!projection) return reject("SCOPE_MISMATCH", "No current thread projection.");
      const action = validateFrameThreadAction(input, projection);
      if (action.action !== "dismiss") {
        const state = refresh()!.anchors.find((anchor) => anchor.threadId === action.threadId);
        if (state?.state !== "found") reject("INVALID_INPUT", "Target is not currently available; use Feedback.");
      }
      return action;
    },
  };
}
