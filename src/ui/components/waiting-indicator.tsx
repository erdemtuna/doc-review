export function WaitingIndicator({ active }: { active: boolean }) {
  return <span className="waiting-indicator" data-active={active} aria-hidden="true">
    {Array.from({ length: 6 }, (_, index) => <span key={index} style={{ animationDelay: `${index * 120}ms` }} />)}
  </span>;
}
