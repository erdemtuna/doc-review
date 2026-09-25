import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { directEditSchema, submissionSchema, submissionResultSchema } from "../../src/contracts/feedback";
import { submissionHistoryItemSchema } from "../../src/contracts/history";
import { EditEvidence, resultAvailability, SubmissionResultNote, type ResultDetail } from "@/components/conversation-results";

afterEach(cleanup);
const pending = directEditSchema.parse({
  editId: "edit", reviewId: "review", pageKey: "page", version: 1, sequence: 1, author: "reviewer", createdAt: 1, updatedAt: 1,
  content: { label: "Title", kind: "edited", before: "Exact before", after: "Exact after", before_html: "<b>Exact before</b>",
    after_html: "<b>Exact after</b>", truncated: false, truncated_fields: [], staged_assets: [] }, source: { state: "pending" }, assets: [],
});
it("pending edit previews retain exact full evidence as text and do not claim source persistence", () => {
  render(<EditEvidence edit={pending} />);
  expect(screen.getByText("Exact before", { exact: true })).toBeVisible();
  expect(screen.getByText("Exact after", { exact: true })).toBeVisible();
  expect(screen.getByText(/Source pending; recording/)).not.toBeVisible();
  expect(document.querySelector("b")).toBeNull();
  expect(document.querySelector("pre")).toHaveTextContent("<b>Exact before</b>");
  expect(screen.getByText("Exact edit details")).toBeVisible();
});
it("saved human edit evidence is independent of any agent outcome", () => {
  const saved = directEditSchema.parse({ ...pending, source: { state: "saved", evidence: {
    evidenceId: "evidence", reviewId: "review", pageKey: "page", editId: "edit", editVersion: 1, sourceHash: "source", savedAt: 2,
  } } });
  render(<EditEvidence edit={saved} />);
  expect(screen.getByText("Already saved by you before Send.")).toBeInTheDocument();
  expect(document.querySelector(".conversation-edit-details pre")).toHaveTextContent('"after": "Exact after"');
});
it("result discovery distinguishes reply-only from every capture state without treating handling as capture success", () => {
  for (const comparisonStatus of ["not-requested", "pending", "ready", "partial", "failed", "unavailable"]) {
    const item = submissionHistoryItemSchema.parse({
      sequence: 1, reviewId: "review", submissionId: "submission", createdAt: 1, state: "handled", comparisonStatus, comparisonCount: 1,
      result: { resultId: "result", body: "Result remains readable", title: "Agent response", effect: "reply-only", createdAt: 2 },
    });
    expect(resultAvailability(item)).toBe("No new source changes reported.");
    const changed = { ...item, result: { ...item.result!, effect: "changes-reported" as const } };
    expect(resultAvailability(changed)).not.toBe("No new source changes reported.");
    if (comparisonStatus === "failed" || comparisonStatus === "unavailable") expect(resultAvailability(changed)).toContain("agent response is still available");
  }
});
it.each(["applied", "deferred"] as const)("full result notes retain exact %s attribution independently of comparison availability", (outcome) => {
  const detail: ResultDetail = {
    submission: submissionSchema.parse({
      submissionId: "submission", reviewId: "review", entryKey: "page", version: 2, sequence: 2, state: "handled",
      createdAt: 1, deliveredAt: 2, completedAt: 3, pageKeys: ["page"], exclusionKeys: ["page"],
      messages: [], edits: [pending], resultId: "result", abandonment: null,
    }),
    result: submissionResultSchema.parse({
      resultId: "result", reviewId: "review", submissionId: "submission", sequence: 3, createdAt: 3,
      author: "agent", body: "Independent agent note.", title: outcome === "applied" ? "What changed" : "Agent response",
      effect: outcome === "applied" ? "changes-reported" : "reply-only", responses: [],
      editOutcomes: [{ editId: pending.editId, editVersion: pending.version, outcome, reason: "Exact outcome explanation." }],
    }), receipt: null,
  };
  render(<SubmissionResultNote detail={detail} />);
  expect(screen.getByRole("region", { name: "Full submission result note" })).toBeVisible();
  expect(screen.getByText("Independent agent note.")).toBeVisible();
  expect(screen.getByText("Source pending at Send")).toBeVisible();
  expect(screen.getByText(outcome === "applied" ? "Agent reported applying this source-pending edit." : "Deferred; no application reported for this edit.")).toBeVisible();
  expect(screen.getByText("Exact outcome explanation.")).toBeVisible();
  expect(screen.queryByText("No changes detected.")).not.toBeInTheDocument();
});
