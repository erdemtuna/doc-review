import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MessageMarkdown, messageLink } from "@/components/message-markdown";

afterEach(cleanup);
it("renders saved structured prose while keeping code and raw markup literal", () => {
  const body = "# Heading\n\n**Answer** and *reason*, ~~old~~.\n\n> Quote\n\n1. First\n2. Second\n\n- [x] Done\n- [ ] Later\n\n`&lt;literal&gt;`\n\n```html\n<script>alert(1)</script>\n```\n\n| Key | Value |\n| --- | --- |\n| One | Two |\n\n<div onclick=\"alert(1)\">Raw HTML</div>";
  render(<MessageMarkdown body={body} />);
  expect(screen.getByRole("heading", { name: "Heading" })).toBeVisible();
  expect(document.querySelector("strong")).toHaveTextContent("Answer");
  expect(document.querySelector("em")).toHaveTextContent("reason");
  expect(document.querySelector("ol")?.children).toHaveLength(2);
  expect(screen.getByRole("img", { name: "Completed task" })).toHaveTextContent("[x]");
  expect(screen.getByRole("table")).toHaveTextContent("One");
  expect(document.querySelector("code")).toHaveTextContent("&lt;literal&gt;");
  expect(document.querySelector("pre")).toHaveTextContent("<script>alert(1)</script>");
  expect(document.querySelector("script,[onclick],input")).toBeNull();
  expect(screen.getByText('<div onclick="alert(1)">Raw HTML</div>')).toBeVisible();
});

it("keeps HTML, image targets and unsafe links inert, with safe navigation in another tab", () => {
  render(<MessageMarkdown body={'![Alt **literal**](https://tracker.invalid/pixel)\n\n<svg onload="alert(1)"></svg>\n\n[bad](javascript:alert%281%29) [file](file:///secret) [relative](/api/end) [good](https://example.com/path?a=1&amp;b=2) [mail](mailto:test@example.com)'} />);
  expect(document.querySelector("img,svg,iframe,script,[src]")).toBeNull();
  expect(screen.getByText("[Image: Alt **literal**]")).toBeVisible();
  expect(screen.getAllByRole("link")).toHaveLength(2);
  expect(screen.getByRole("link", { name: "good" })).toHaveAttribute("href", "https://example.com/path?a=1&b=2");
  expect(screen.getByRole("link", { name: "good" })).toHaveAttribute("target", "_blank");
  expect(screen.getByRole("link", { name: "good" })).toHaveAttribute("rel", "noopener noreferrer");
});

it.each(["javascript:alert(1)", "jav&#97;script:alert(1)", "java&#x09;script:alert(1)", "data:text/html,x",
  "file:///secret", "//example.com", "/r/review", "#thread", "https:\\\\evil.test", "https://exa\nmple.com", "%6aavascript:alert(1)"])(
  "rejects unsafe or ambiguous message link %s", href => { expect(messageLink(href)).toBeNull(); },
);

it("retains every word of long messages and uses inert unknown tokens", () => {
  const body = `${"word ".repeat(1000)}last-word`;
  render(<MessageMarkdown body={body} />);
  expect(document.querySelector(".message-markdown")).toHaveTextContent(body);
});
