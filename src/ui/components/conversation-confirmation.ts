import type { ConversationController } from "../../conversation-controller";

type Confirmation = NonNullable<ReturnType<ConversationController["getSnapshot"]>["confirmation"]>;
type Presentation = { title: string; verb: string; variant: "destructive" | "outline" };

const actions = {
  end: { title: "End shared review?", verb: "End review", variant: "destructive" },
  abandon: { title: "Abandon submission?", verb: "Abandon submission", variant: "destructive" },
  delete: { title: "Delete thread?", verb: "Delete thread", variant: "destructive" },
  revert: { title: "Revert source edits?", verb: "Revert edits", variant: "destructive" },
  resolve: { title: "Resolve conversation?", verb: "Resolve", variant: "outline" },
} satisfies Record<Confirmation["action"], Presentation>;

export function confirmationPresentation(action: Confirmation["action"], resolved: boolean): Presentation {
  return action === "resolve" && resolved
    ? { title: "Reopen conversation?", verb: "Reopen", variant: "outline" } : actions[action];
}
