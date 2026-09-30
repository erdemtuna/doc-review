import { Fragment, useMemo, type ReactNode } from "react";
import { marked, type Token, type Tokens } from "marked";

function linkTarget(value: string): string | undefined {
  const href = value.trim();
  return /^(https?:\/\/|mailto:)/i.test(href) && !/[\u0000-\u0020\u007f]/.test(href) ? href : undefined;
}

function renderTokens(tokens: Token[]): ReactNode {
  return tokens.map((token, index) => {
    const children = "tokens" in token && token.tokens ? renderTokens(token.tokens) : null;
    let node: ReactNode;
    switch (token.type) {
      case "space": return null;
      case "paragraph": node = <p>{children}</p>; break;
      case "text": case "escape": node = children ?? token.text; break;
      case "strong": node = <strong>{children}</strong>; break;
      case "em": node = <em>{children}</em>; break;
      case "del": node = <del>{children}</del>; break;
      case "codespan": node = <code>{token.text}</code>; break;
      case "code": node = <pre><code>{token.text}</code></pre>; break;
      // Source examples remain visible and inert, never executable markup.
      case "html": node = <code>{token.text}</code>; break;
      case "br": node = <br />; break;
      case "hr": node = <hr />; break;
      case "heading": node = <p className="conversation-text-heading"><strong>{children}</strong></p>; break;
      case "blockquote": node = <blockquote>{children}</blockquote>; break;
      case "link": {
        const href = linkTarget(token.href);
        node = href ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : children;
        break;
      }
      case "image": node = <span>{token.text || "Image"}</span>; break;
      case "list": {
        const items = token.items.map((item: Tokens.ListItem, itemIndex: number) => <li key={itemIndex}>
          {item.task && <span aria-label={item.checked ? "Completed" : "Not completed"}>{item.checked ? "[x] " : "[ ] "}</span>}
          {renderTokens(item.tokens)}
        </li>);
        node = token.ordered ? <ol start={typeof token.start === "number" ? token.start : undefined}>{items}</ol> : <ul>{items}</ul>;
        break;
      }
      case "table":
        node = <div className="conversation-text-table"><table>
          <thead><tr>{token.header.map((cell: Tokens.TableCell, cellIndex: number) => <th key={cellIndex}>{renderTokens(cell.tokens)}</th>)}</tr></thead>
          <tbody>{token.rows.map((row: Tokens.TableCell[], rowIndex: number) => <tr key={rowIndex}>
            {row.map((cell: Tokens.TableCell, cellIndex: number) => <td key={cellIndex}>{renderTokens(cell.tokens)}</td>)}
          </tr>)}</tbody>
        </table></div>;
        break;
      default: node = token.raw;
    }
    return <Fragment key={index}>{node}</Fragment>;
  });
}

export function ConversationText({ children, className = "" }: { children: string; className?: string }) {
  const content = useMemo(() => renderTokens(marked.lexer(children, { gfm: true, breaks: true })), [children]);
  return <div className={`conversation-text ${className}`}>{content}</div>;
}
