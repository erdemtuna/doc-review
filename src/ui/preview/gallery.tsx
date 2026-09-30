import { useState, type ReactNode } from "react";
import { Icon } from "@/components/icon";
import { Brand } from "@/components/brand";
import { ConversationAuthor, ConversationIntent, ConversationStatus, ConversationSource, ConversationTime, ConversationMenu } from "@/components/conversation-controls";
import { ReviewOptions } from "@/components/review-options";
import { DisclosureTrigger } from "@/components/ui/disclosure-trigger";
import { ResultPreview } from "@/components/conversation-results";
import { ComparisonView } from "@/components/comparison";
import type { ComparisonInput } from "@/components/comparison";
import { ReceiptRecovery } from "@/components/recovery-notice";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { ChoiceMenu } from "@/components/ui/choice-menu";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import { FilterButton } from "@/components/ui/filter-button";
import { Checkbox } from "@/components/ui/checkbox";
import { IconButton } from "@/components/ui/icon-button";
import { Timeline, TimelineItem } from "@/components/ui/timeline";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

const comparison: ComparisonInput = { available: true, rows: [
  { id: "quote", kind: "modified", changeId: "quote",
    beforeBlock: { tag: "blockquote", text: "Old guidance", runs: [{ text: "Old guidance", marks: [] }] },
    afterBlock: { tag: "blockquote", text: "Clear next step", runs: [{ text: "Clear next step", marks: ["mark"] }] } },
  { id: "rule", kind: "unchanged", beforeBlock: { tag: "hr", text: "" }, afterBlock: { tag: "hr", text: "" } },
  { id: "cell", kind: "modified", changeId: "cell",
    beforeBlock: { tag: "td", text: "Before", selector: "body > table:nth-of-type(1) > tbody:nth-of-type(1) > tr:nth-of-type(1) > td:nth-of-type(1)" },
    afterBlock: { tag: "td", text: "After", selector: "body > table:nth-of-type(1) > tbody:nth-of-type(1) > tr:nth-of-type(1) > td:nth-of-type(1)" } },
], changes: [{ id: "quote", kind: "modified", before: "Old guidance", after: "Clear next step" },
  { id: "cell", kind: "modified", before: "Before", after: "After" }] };

function Section({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return <section className="preview-section" aria-label={title}>
    <div className="preview-section-heading">
      <h2 className="preview-subtitle">{title}</h2>
      <p className="mt-1 text-xs text-muted-foreground">{description}</p>
    </div>
    <div className="preview-section-body">{children}</div>
  </section>;
}

export function initialTheme(): "light" | "dark" {
  return localStorage.getItem("doc-review:theme") === "dark" ? "dark" : "light";
}

export function Gallery() {
  const [theme, setTheme] = useState(initialTheme);
  const [optionsOpen, setOptionsOpen] = useState(false), [expanded, setExpanded] = useState(true);
  const [note, setNote] = useState("Keep the introduction concise and make the next step clearer.");
  const [format, setFormat] = useState("content");
  const [round, setRound] = useState("2"), [roundOpen, setRoundOpen] = useState(false);
  const [filters, setFilters] = useState({ open: true, resolved: false });
  const [intent, setIntent] = useState(false);
  const [notice, setNotice] = useState("Sample controls only. No review data is changed.");
  function switchTheme(next: "light" | "dark") {
    localStorage.setItem("doc-review:theme", next);
    document.documentElement.dataset.theme = next;
    setTheme(next);
  }
  return <div className="review-ui preview-shell">
    <header className="preview-header">
      <div className="flex min-w-0 items-center gap-3">
        <Brand />
        <div><p className="text-sm font-semibold">doc review</p><p className="text-xs text-muted-foreground">Design foundations</p></div>
      </div>
      <ReviewOptions open={optionsOpen} onOpenChange={setOptionsOpen} theme={theme} onThemeChange={switchTheme} />
    </header>
    <main className="preview-main">
      <div className="preview-intro">
        <div className="mb-4 flex items-center gap-2"><Badge variant="outline">Components</Badge><span className="preview-kicker">Current production vocabulary</span></div>
        <h1 className="preview-title">Less chrome.<br />More room to review.</h1>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">Shared production components with synthetic state. This gallery does not send feedback or simulate controller success; use preview:shell for a live isolated review.</p>
      </div>
      <div className="preview-grid">
        <Section title="Controls & interaction" description="Try the controls, open a menu, and move through the page with Tab.">
          <div className="preview-field">
            <p className="preview-kicker">Action hierarchy</p>
            <div className="preview-row">
              <Button onClick={() => setNotice("Sample action completed. No feedback was sent.")}><Icon name="send" />Send feedback</Button>
              <Button variant="outline" onClick={() => setNotice("Sample secondary action selected.")}>Capture result</Button>
              <Button variant="ghost" onClick={() => setNotice("Sample action cancelled.")}>Cancel</Button>
              <Button variant="secondary">Selected context</Button>
              <Button variant="destructive">Delete thread</Button>
              <Button variant="destructive-ghost"><Icon name="circleX" />Abandon</Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild><IconButton variant="outline" size="icon" aria-label="Open sample menu"><Icon name="moreHorizontal" /></IconButton></DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="review-ui">
                  <DropdownMenuLabel>Sample actions</DropdownMenuLabel>
                  <DropdownMenuItem onSelect={() => setNotice("Edit selected from the sample menu.")}><Icon name="pencil" />Edit comment</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setNotice("Selection revealed in the sample.")}><Icon name="eye" />Reveal selection</DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem disabled>Nothing to restore</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <div className="preview-row">
              <Button disabled><Icon name="send" />Nothing to send</Button>
              <Button variant="outline" disabled aria-busy="true">Saving changes...</Button>
            </div>
          </div>
          <div className="grid gap-5 sm:grid-cols-2">
            <div className="preview-field">
              <Label htmlFor="sample-round">Submission</Label>
              <ChoiceMenu id="sample-round" label="Submission" value={round} triggerLabel={`Submission ${round}`}
                options={[{ value: "2", label: "Submission 2 - Handled" }, { value: "1", label: "Submission 1 - Handled" }]}
                open={roundOpen} onOpenChange={setRoundOpen} restoreFocus
                onValueChange={value => { setRound(value); setNotice(`Sample submission ${value} selected.`); }} />
            </div>
            <div className="preview-field">
              <Label id="sample-format-label">Comparison format</Label>
              <SegmentedControl aria-labelledby="sample-format-label">
                <SegmentedControlItem selected={format === "content"} onClick={() => setFormat("content")}>Document</SegmentedControlItem>
                <SegmentedControlItem selected={format === "source"} onClick={() => setFormat("source")}>Source</SegmentedControlItem>
              </SegmentedControl>
            </div>
            <div className="preview-field">
              <p className="preview-kicker">Independent filters (both or neither)</p>
              <div className="conversation-filter-buttons" role="group" aria-label="Sample conversation filters">
                {(["open", "resolved"] as const).map(filter => <FilterButton key={filter}
                  selected={filters[filter]} onClick={() => setFilters(current => ({ ...current, [filter]: !current[filter] }))}>
                  {filter === "open" ? "Open" : "Resolved"}</FilterButton>)}
              </div>
            </div>
          </div>
          <div className="preview-field">
            <Label htmlFor="sample-note">Note to agent</Label>
            <Textarea id="sample-note" value={note} onChange={(event) => setNote(event.target.value)} rows={3}
              aria-describedby="sample-note-help" />
            <label className="conversation-intent"><Checkbox checked={intent} onCheckedChange={value => setIntent(value === true)} />Request a change</label>
            <p id="sample-note-help" className="text-xs text-muted-foreground">Edits here are local to this preview. Try selecting text and changing theme.</p>
          </div>
          <div className="preview-field">
            <Label htmlFor="sample-error">Error treatment</Label>
            <Textarea id="sample-error" defaultValue="A sample draft that stays available after a failed save." rows={2}
              aria-invalid="true" aria-describedby="sample-error-help" />
            <p id="sample-error-help" className="text-xs text-destructive">Sample error: could not save. Your draft is still here.</p>
          </div>
          <div className="preview-field">
            <p className="preview-kicker">Confirmation treatment</p>
            <div className="preview-row">
              <AlertDialog>
                <AlertDialogTrigger asChild><Button variant="outline"><Icon name="trash" />Try confirmation</Button></AlertDialogTrigger>
                <AlertDialogContent className="review-ui">
                  <AlertDialogHeader>
                    <AlertDialogTitle>Discard sample edits?</AlertDialogTitle>
                    <AlertDialogDescription>This demonstrates the confirmation style. It will not delete documents, discard your note, or end a review.</AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Keep editing</AlertDialogCancel>
                    <AlertDialogAction variant="destructive" onClick={() => setNotice("Sample confirmation completed. Nothing was deleted.")}>Discard sample edits</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
              <span className="text-xs text-muted-foreground">Safe focus on the cancel action.</span>
            </div>
          </div>
          <p role="status" className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">{notice}</p>
        </Section>
        <div className="grid content-start gap-5">
          <Section title="Color & surfaces" description="Semantic tokens, shared by every component.">
            <div className="grid grid-cols-3 gap-3">
              {[
                ["Canvas", "--background"], ["Surface", "--card"], ["Muted", "--muted"],
                ["Action", "--primary"], ["Focus", "--ring"], ["Border", "--border"],
              ].map(([label, token]) => <div key={token} className="min-w-0">
                <div className="preview-swatch" style={{ background: `var(${token})` }} />
                <p className="mt-1.5 text-xs text-muted-foreground">{label}</p>
              </div>)}
            </div>
            <div className="preview-field">
              <p className="preview-kicker">Type & density</p>
              <p className="text-lg font-semibold tracking-tight">A clear next step</p>
              <p className="text-sm">Body text stays readable without competing with the document.</p>
              <p className="text-xs text-muted-foreground">Supporting details stay secondary, not invisible.</p>
              <p className="font-mono text-xs text-muted-foreground">24 / 28 / 32px controls; 13px conversation text; 8px base radius</p>
            </div>
          </Section>
          <Section title="Comparison semantics" description="The live inert comparison renderer with saved synthetic rich content.">
            <div className="preview-row">
              <Badge className="bg-review-added text-review-added-foreground">+ 3 Added</Badge>
              <Badge className="bg-review-modified text-review-modified-foreground">~ 2 Modified</Badge>
              <Badge className="bg-review-removed text-review-removed-foreground">- 1 Removed</Badge>
            </div>
            <div className="comparison-host">
              <div className="comparison-surface comparison-content"><ComparisonView comparison={comparison} selectedIndex={0} /></div>
            </div>
            <p className="text-xs text-muted-foreground">Text labels and marks accompany color. {format === "content" ? "Content" : "Source"} is selected in the sample format control.</p>
          </Section>
          <Section title="Conversations and results" description="Shared informational hints, commands, unboxed messages and lifecycle evidence.">
            <article className="conversation-thread inventory-card" data-expanded={expanded}>
              <header><div className="conversation-thread-toolbar">
                <ConversationSource target={{ kind: "element", anchor: { selector: "p", label: "Sample passage" } }} />
                <IconButton aria-label="Show in document" onClick={() => setNotice("Sample Locate action; no document is attached.")}><Icon name="locate" /></IconButton>
                <ConversationMenu actions={[{ label: "Focus", run: () => setNotice("Sample Focus action; use the live shell to move a conversation.") },
                  { label: "Delete thread", destructive: true, disabled: true, run() {} }]} />
                <DisclosureTrigger iconOnly expanded={expanded} controls="sample-conversation"
                  aria-label={expanded ? "Collapse conversation" : "Expand conversation"} onClick={() => setExpanded(value => !value)} />
              </div></header>
              <div id="sample-conversation" hidden={!expanded}>
              <div className="conversation-meta"><ConversationAuthor role="You" /><ConversationTime value={Date.UTC(2026, 8, 29)} />
                <IconButton aria-label="Edit message" onClick={() => setNotice("Sample Edit action; use the live shell to edit saved feedback.")}><Icon name="pencil" /></IconButton>
                <ConversationIntent /><ConversationStatus kind="not-sent" /></div>
              <p className="conversation-body">Keep this message unboxed inside its conversation card.</p>
              <div className="preview-row" aria-label="Informational outcome vocabulary">
                {(["resolved", "answered", "applied", "clarification-needed", "deferred"] as const).map(kind => <ConversationStatus key={kind} kind={kind} />)}
              </div></div>
            </article>
            <Timeline aria-label="Sample review timeline"><TimelineItem tone="response" icon={<Icon name="messages" />}>
              <strong>Agent response</strong>
              <ResultPreview body="A complete response stays readable and can expand without leaving the result. This synthetic response demonstrates the production preview and disclosure composition."
                actions={control => <div className="conversation-actions"><Button size="sm" onClick={() => setNotice("Sample result entry; use the live shell for navigation.")}>View response</Button>{control}</div>} />
            </TimelineItem></Timeline>
            <ReceiptRecovery uncertain={{ operation: "send", requestId: "synthetic-request", message: "Receipt could not be confirmed. Your exact request is retained." }}
              busy={false} onCheck={() => setNotice("Preview only: Check receipt requested.")} onRetry={() => setNotice("Preview only: Retry same request requested.")}
              onRefresh={() => setNotice("Preview only: Refresh review requested.")} />
          </Section>
        </div>
      </div>
      <footer className="preview-footer">
        <span>Production components; synthetic states, not an alternate workflow.</span>
        <span><kbd className="preview-key">Tab</kbd> focus <span className="mx-1">/</span> <kbd className="preview-key">Esc</kbd> dismiss</span>
      </footer>
    </main>
  </div>;
}
