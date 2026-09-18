export function launchBrief(version) {
  const title = ["Launch brief", "Launch brief: staged rollout", "Launch brief: ready for review"][version];
  const summary = [
    "Ship the new workspace to everyone on Friday.",
    "Start with the internal team, then invite a small customer cohort.",
    "Start with the internal team, measure the results, then expand the customer cohort.",
  ][version];
  const unchanged = Array.from({ length: 18 }, (_, index) =>
    `    <p id="reference-${index}">Reference ${index + 1}: Keep document ownership clear, preserve drafts, and explain the reason for each proposed change.</p>`
  ).join("\n");
  return `<!doctype html><html lang="en"><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; color: #263244; background: #f6f8fa; font: 16px/1.7 system-ui, sans-serif; }
    main { max-width: 860px; margin: auto; padding: 28px 24px 80px; }
    h1 { font-size: clamp(26px, 5vw, 36px); line-height: 1.25; }
    h2 { margin-top: 32px; font-size: 22px; }
    .eyebrow, .hint { font-size: 13px; color: #536579; }
    .notice { padding: 16px; border: 1px solid #ccd5df; border-radius: 8px; background: white; }
    table { border-collapse: collapse; width: 100%; background: white; }
    th, td { border: 1px solid #ccd5df; padding: 9px; text-align: left; }
    pre { overflow: auto; padding: 14px; background: #eaf0f5; border-radius: 6px; }
    input, select { max-width: 100%; font: inherit; padding: 8px; }
    label { display: block; margin: 12px 0; }
    .nested { height: 220px; overflow: auto; border: 1px solid #ccd5df; padding: 16px; background: white; }
    a { color: #1b559b; }
  </style>
</head>
<body>
  <main>
    <p class="eyebrow">DISPOSABLE REVIEW EXAMPLE / HTML</p>
    <h1 id="demo-title">${title}</h1>
    <p id="intro">${summary}</p>
    <p class="notice">This copy is safe to edit, revert, comment on, or end. Open Changes to inspect two seeded review rounds. Round 1 includes a second page with Source-only coverage; Round 2 has both Content and Source.</p>
    <p id="detail">The reviewer should see <strong>${version === 0 ? "every change" : "the important changes"}</strong>, keep <em>unsent work</em>, and inspect <a href="notes.md">the rollout notes</a> without losing the current review.</p>
    <h2>Milestones</h2>
    <table>
      <thead><tr><th>Stage</th><th>Owner</th><th>Exit check</th></tr></thead>
      <tbody>
        <tr><th>Internal preview</th><td>Workspace team</td><td>${version === 0 ? "Ship Friday" : "Drafts and keyboard flow preserved"}</td></tr>
        <tr><th>Customer cohort</th><td>${version < 2 ? "Support" : "Support and engineering"}</td><td>${version === 0 ? "All customers" : "Ten invited reviewers"}</td></tr>
        ${version > 0 ? '<tr><th>Expansion</th><td>Release owner</td><td>Review feedback before widening access</td></tr>' : ""}
      </tbody>
    </table>
    <h2>Review sequence</h2>
    <ol>
      <li>Read the summary and leave one anchored comment.</li>
      <li>${version === 0 ? "Approve the release." : "Compare Content and Source before approving the release."}</li>
      <li>Keep an overall note while switching between Review and Changes.</li>
    </ol>
    ${version === 0 ? '<p id="obsolete">A separate overflow menu is required for every comment action.</p>' : '<p id="direct-actions">Edit and Delete are visible icon actions; Delete still requires confirmation.</p>'}
    <h2>Implementation note</h2>
    <pre id="snippet"><code>review({
  rollout: "${version === 0 ? "all-at-once" : "staged"}",
  preserveDrafts: true,
  ${version < 2 ? "capture: \"optional\"" : "capture: \"optional, never blocks feedback\""}
});</code></pre>
    <p><img src="roadmap.svg" alt="${version < 2 ? "Three rollout stages" : "Three rollout stages with review checkpoints"}" width="260" height="64"></p>
    <h2>Page-owned controls</h2>
    <label>Page-owned draft <input aria-label="Page-owned draft" value="Keep this authored value"></label>
    <label>Priority <select aria-label="Review priority"><option>Clarity</option><option>Accuracy</option><option>Accessibility</option></select></label>
    <details><summary>Expand authored details</summary><p>These controls belong to the document, not React shell state.</p></details>
    <h2>Long unchanged context</h2>
    <p class="hint">Changes collapses unchanged context. Expand a gap and use Previous, Next, and Jump to change without resetting it.</p>
${unchanged}
    <h2>Nested scrolling</h2>
    <div class="nested" tabindex="0" aria-label="Nested review content">
      <p id="nested">Open a comment here and scroll this panel. Back to selection should reveal the original target.</p>
      <p style="min-height: 280px">Keep the same composer draft while the target moves.</p>
      <p id="nested-end">The final nested paragraph is another selectable target.</p>
    </div>
    <h2>Decision</h2>
    <p id="decision">${version < 2 ? "Confirm the owners and review the rollout criteria." : "Owners are assigned. Expand only after reviewing cohort feedback."}</p>
  </main>
</body>
</html>${version === 0 ? "" : "\n"}`;
}

export function rolloutNotes(version) {
  const content = `# Rollout notes

This Markdown file is a **feedback-only** document: edits become feedback, not saved HTML.

## Audience

${version === 0 ? "Send the announcement to every customer." : "Invite ten reviewers before expanding the announcement."}

## Checklist

1. Keep the current document alive.
2. ${version < 2 ? "Check the draft before sending." : "Check draft preservation, keyboard focus, and retry behavior before sending."}
3. Compare the result with the saved baseline.

## Status

| Area | Outcome |
| --- | --- |
| Drafts | Preserved |
| Keyboard | ${version < 2 ? "Needs review" : "Reviewed"} |
| Capture | Optional |

\`\`\`text
${version < 2 ? "next: collect review feedback" : "next: expand only after review"}
\`\`\`

[Back to the launch brief](launch-brief.html)
`;
  return version === 0 ? content.replaceAll("\n", "\r\n").trimEnd() : content;
}

export const roadmap = `<svg xmlns="http://www.w3.org/2000/svg" width="260" height="64" viewBox="0 0 260 64"><rect width="260" height="64" rx="8" fill="#eaf0f5"/><g fill="#263244" font-family="sans-serif" font-size="12"><text x="14" y="36">Internal</text><text x="98" y="36">Cohort</text><text x="178" y="36">Expand</text></g><path d="M63 32h25m56 0h24" stroke="#687f99" stroke-width="2"/></svg>`;
