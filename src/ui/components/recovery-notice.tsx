import type { ReactNode } from "react";
import { Button } from "./ui/button";

export function RecoveryNotice({ title, messages = [], requestId, actions, children, tone = "error" }: {
  title?: string; messages?: readonly string[]; requestId?: string;
  actions?: ReactNode; children?: ReactNode; tone?: "error" | "warning";
}) {
  return <section className="review-recovery" data-tone={tone}>
    {(title || messages.length > 0) && <div className="review-recovery-message" role={tone === "error" ? "alert" : "status"}>
      {title && <strong>{title}</strong>}{messages.map((message, index) => <p key={index}>{message}</p>)}
    </div>}
    {requestId && <code>{requestId}</code>}
    {children}
    {actions && <div className="review-recovery-actions">{actions}</div>}
  </section>;
}

export function ReceiptRecovery({ uncertain, error, busy, onCheck, onRetry, onRefresh }: {
  uncertain: { operation: string; message: string; requestId: string };
  error?: string;
  busy: boolean; onCheck(): void; onRetry(): void; onRefresh?(): void;
}) {
  return <RecoveryNotice title={`${uncertain.operation}: acceptance unknown`}
    messages={error && error !== uncertain.message ? [error, uncertain.message] : [uncertain.message]}
    requestId={uncertain.requestId} actions={<>
      <Button size="sm" disabled={busy} aria-busy={busy} onClick={onCheck}>Check receipt</Button>
      <Button size="sm" variant="secondary" disabled={busy} aria-busy={busy} onClick={onRetry}>Retry same request</Button>
      {onRefresh && <Button size="sm" variant="outline" disabled={busy} onClick={onRefresh}>Refresh review</Button>}
    </>} />;
}
