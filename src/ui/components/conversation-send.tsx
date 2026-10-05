import { useLayoutEffect, useRef } from "react";
import { Button } from "./ui/button";
import { ControlHint } from "./ui/control-hint";
import type { SendAvailability } from "./conversation-presentation";

export function ConversationSend({ availability, count, selection, excludedDrafts, busy, onSend }: {
  availability: SendAvailability; count: number | null; selection: string; excludedDrafts: number; busy: boolean; onSend(): void;
}) {
  const wrapper = useRef<HTMLSpanElement>(null), button = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (!availability.disabled && document.activeElement === wrapper.current) button.current?.focus({ preventScroll: true });
  }, [availability.disabled]);
  const descriptions = [
    availability.disabled ? "sendDisabledReason" : "", selection ? "sendSelectionDescription" : "",
    excludedDrafts ? "sendDraftExclusion" : "",
  ].filter(Boolean).join(" ") || undefined;
  return <>
    <span id="sendDisabledReason" className="sr-only">{availability.reason?.description}</span>
    <span id="sendSelectionDescription" className="sr-only">{selection}</span>
    <ControlHint hint={availability.reason?.description} disabled={!availability.disabled}>
      <span ref={wrapper} className="send-explanation" tabIndex={availability.disabled ? 0 : undefined}
        role={availability.disabled ? "group" : undefined} aria-label={availability.disabled ? "Send unavailable" : undefined}
        aria-describedby={descriptions}>
        <Button ref={button} id="send" className="feedback-send" aria-label="Send" aria-describedby={descriptions}
          aria-busy={busy} disabled={availability.disabled} onClick={onSend}>
          {count === null ? "Send to agent" : `Send to agent (${count})`}
        </Button>
      </span>
    </ControlHint>
  </>;
}
