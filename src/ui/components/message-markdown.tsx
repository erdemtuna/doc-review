import { useMemo, type ReactNode } from "react";
import { Marked, type Token, type MarkedToken } from "marked";

const parser = new Marked({ gfm: true, breaks: true });

function decode(text: string) {
  return text.replace(/&(?:#\d+|#x[\da-f]+|[a-z][a-z\d]+);/gi, entity => {
    const field = document.createElement("textarea");
    // Only an individual character reference reaches this inert decoder.
    field.innerHTML = entity;
    return field.value;
  });
}

export function messageLink(href: string): string | null {
  const value = decode(href).trim();
  if (/[\u0000-\u0020\u007f]/.test(value) || !/^(https?:\/\/|mailto:)/i.test(value)) return null;
  try {
    const url = new URL(value);
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

function renderTokens(tokens: readonly Token[]): ReactNode {
  return tokens.map((input, index) => {
    // This private lexer has no extensions, so it emits only built-in tokens.
    const token = input as MarkedToken;
    const children = "tokens" in token && token.tokens ? renderTokens(token.tokens) : null;
    switch (token.type) {
      case "space": return null;
      case "paragraph": return <p key={index}>{children}</p>;
      case "heading": return <h4 key={index}>{children}</h4>;
      case "text": return <span key={index}>{children ?? decode(token.text)}</span>;
      case "escape": return <span key={index}>{decode(token.text)}</span>;
      case "strong": return <strong key={index}>{children}</strong>;
      case "em": return <em key={index}>{children}</em>;
      case "del": return <del key={index}>{children}</del>;
      case "codespan": return <code key={index}>{token.text}</code>;
      case "code": return <pre key={index} tabIndex={0}><code>{token.text}</code></pre>;
      case "blockquote": return <blockquote key={index}>{children}</blockquote>;
      case "br": return <br key={index} />;
      case "hr": return <hr key={index} />;
      case "html": return <code key={index}>{token.raw}</code>;
      case "image": return <span key={index} className="message-image-alt">[Image: {decode(token.text)}]</span>;
      case "link": {
        const href = messageLink(token.href);
        return href ? <a key={index} href={href} target="_blank" rel="noopener noreferrer">{children}</a>
          : <span key={index}>{children}</span>;
      }
      case "list": {
        const items = token.items.map((item, i) => <li key={i}>
          {item.task && <span role="img" aria-label={item.checked ? "Completed task" : "Incomplete task"}>{item.checked ? "[x] " : "[ ] "}</span>}
          {renderTokens(item.tokens)}
        </li>);
        return token.ordered ? <ol key={index} start={token.start || 1}>{items}</ol> : <ul key={index}>{items}</ul>;
      }
      case "table": return <div className="message-table" key={index} tabIndex={0} role="region" aria-label="Message table"><table>
        <thead><tr>{token.header.map((cell, i) => <th key={i}>{renderTokens(cell.tokens)}</th>)}</tr></thead>
        <tbody>{token.rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{renderTokens(cell.tokens)}</td>)}</tr>)}</tbody>
      </table></div>;
      default: return <span key={index}>{input.raw}</span>;
    }
  });
}

/** Saved prose only. Source evidence and composer values stay literal. */
export function MessageMarkdown({ body, className = "" }: { body: string; className?: string }) {
  const content = useMemo(() => renderTokens(parser.lexer(body)), [body]);
  return <div className={`message-markdown ${className}`}>{content}</div>;
}
