import { useState, type ReactNode } from "react";
import { Icon } from "@/components/icon";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

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
  const [note, setNote] = useState("Keep the introduction concise and make the next step clearer.");
  const [format, setFormat] = useState("content");
  const [notice, setNotice] = useState("Sample controls only. No review data is changed.");
  function switchTheme() {
    const next = theme === "dark" ? "light" : "dark";
    localStorage.setItem("doc-review:theme", next);
    document.documentElement.dataset.theme = next;
    setTheme(next);
  }
  return <div className="review-ui preview-shell">
    <header className="preview-header">
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-foreground text-background"><Icon name="messages" /></span>
        <div><p className="text-sm font-semibold">doc review</p><p className="text-xs text-muted-foreground">Design foundations</p></div>
      </div>
      <Button variant="outline" size="sm" onClick={switchTheme} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}>
        <Icon name={theme === "dark" ? "sun" : "moon"} /><span className="hidden sm:inline">{theme === "dark" ? "Light" : "Dark"} theme</span>
      </Button>
    </header>
    <main className="preview-main">
      <div className="preview-intro">
        <div className="mb-4 flex items-center gap-2"><Badge variant="outline">G1</Badge><span className="preview-kicker">Component review / 01 of 10</span></div>
        <h1 className="preview-title">Less chrome.<br />More room to review.</h1>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">Compact controls, a quiet neutral palette, and clearer states. This is an isolated design preview; the existing review workspace has not changed.</p>
      </div>
      <div className="preview-grid">
        <Section title="Controls & interaction" description="Try the controls, open a menu, and move through the page with Tab.">
          <div className="preview-field">
            <p className="preview-kicker">Action hierarchy</p>
            <div className="preview-row">
              <Button onClick={() => setNotice("Sample action completed. No feedback was sent.")}><Icon name="send" />Send feedback</Button>
              <Button variant="outline" onClick={() => setNotice("Sample secondary action selected.")}>Capture result</Button>
              <Button variant="ghost" onClick={() => setNotice("Sample action cancelled.")}>Cancel</Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild><Button variant="outline" size="icon" aria-label="Open sample menu"><Icon name="moreHorizontal" /></Button></DropdownMenuTrigger>
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
              <Label htmlFor="sample-round">Review round</Label>
              <NativeSelect id="sample-round" defaultValue="2" onChange={(event) => setNotice(`Sample round ${event.target.value} selected.`)}>
                <NativeSelectOption value="2">Round 2 - Completed</NativeSelectOption>
                <NativeSelectOption value="1">Round 1 - Completed</NativeSelectOption>
              </NativeSelect>
            </div>
            <div className="preview-field">
              <Label id="sample-format-label">Comparison format</Label>
              <ToggleGroup type="single" variant="outline" value={format} aria-labelledby="sample-format-label"
                onValueChange={(value) => { if (value) setFormat(value); }}>
                <ToggleGroupItem value="content">Content</ToggleGroupItem>
                <ToggleGroupItem value="source">Source</ToggleGroupItem>
              </ToggleGroup>
            </div>
          </div>
          <div className="preview-field">
            <Label htmlFor="sample-note">Overall note</Label>
            <Textarea id="sample-note" value={note} onChange={(event) => setNote(event.target.value)} rows={3}
              aria-describedby="sample-note-help" />
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
                    <AlertDialogAction onClick={() => setNotice("Sample confirmation completed. Nothing was deleted.")}>Discard sample edits</AlertDialogAction>
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
              <p className="font-mono text-xs text-muted-foreground">32px controls / 8px base radius / system fonts</p>
            </div>
          </Section>
          <Section title="Comparison semantics" description="Color samples only, not the new comparison renderer.">
            <div className="preview-row">
              <Badge className="bg-review-added text-review-added-foreground">+ 3 Added</Badge>
              <Badge className="bg-review-modified text-review-modified-foreground">~ 2 Modified</Badge>
              <Badge className="bg-review-removed text-review-removed-foreground">- 1 Removed</Badge>
            </div>
            <div className="overflow-hidden rounded-md border border-border">
              <div className="preview-diff" style={{ background: "var(--review-removed)", color: "var(--review-removed-foreground)", borderColor: "var(--review-removed-border)" }}>
                <span aria-hidden="true">- </span><del>Send a separate note for every change.</del>
              </div>
              <div className="preview-diff" style={{ background: "var(--review-added)", color: "var(--review-added-foreground)", borderColor: "var(--review-added-border)" }}>
                <span aria-hidden="true">+ </span><ins>Send your feedback together, in one batch.</ins>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">Text labels and marks accompany color. {format === "content" ? "Content" : "Source"} is selected in the sample format control.</p>
          </Section>
        </div>
      </div>
      <footer className="preview-footer">
        <span>Review the foundation before we apply it to the shell.</span>
        <span><kbd className="preview-key">Tab</kbd> focus <span className="mx-1">/</span> <kbd className="preview-key">Esc</kbd> dismiss</span>
      </footer>
    </main>
  </div>;
}
