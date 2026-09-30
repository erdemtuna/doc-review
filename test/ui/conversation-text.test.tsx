import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ConversationText } from "@/components/conversation-text";

afterEach(cleanup);

it("renders paragraphs, emphasis, lists, code and tables without losing source examples", () => {
  const { container } = render(<ConversationText>{`**Decision:** use *earlier* findings.

- Preserve history
- Keep \`<b>exact markup</b>\`

| State | Result |
| --- | --- |
| Open | Read |

\`\`\`html
<b>earlier decisions</b>
\`\`\`

The exact <b>earlier decisions</b> markup is retained.`}</ConversationText>);
  expect(container.querySelector("strong")).toHaveTextContent("Decision:");
  expect(container.querySelector("em")).toHaveTextContent("earlier");
  expect(screen.getAllByRole("listitem")).toHaveLength(2);
  expect(screen.getByRole("table")).toBeVisible();
  expect(container.querySelector("pre code")).toHaveTextContent("<b>earlier decisions</b>");
  expect(container.querySelector("b")).toBeNull();
  expect(container.textContent).toContain("The exact <b>earlier decisions</b> markup is retained.");
});

it("keeps hostile HTML and unsafe links inert without loading images", () => {
  const { container } = render(<ConversationText>{`<script>alert(1)</script>

<img src=x onerror=alert(1)>

[bad](javascript:alert) [data](data:text/html,evil) [safe](https://example.com)

![remote](https://example.com/image.png)`}</ConversationText>);
  expect(container.querySelector("script,img,iframe,svg")).toBeNull();
  expect(screen.getAllByRole("link")).toHaveLength(1);
  expect(screen.getByRole("link")).toHaveAttribute("href", "https://example.com");
  expect(screen.getByRole("link")).toHaveAttribute("rel", "noopener noreferrer");
  expect(container.textContent).toContain("<script>alert(1)</script>");
});

it("preserves multiline plain text and task list state", () => {
  const { container } = render(<ConversationText>{"First line\nSecond line\n\n- [x] Done\n- [ ] Next"}</ConversationText>);
  expect(container.querySelector("br")).not.toBeNull();
  expect(screen.getByLabelText("Completed")).toBeVisible();
  expect(screen.getByLabelText("Not completed")).toBeVisible();
});
