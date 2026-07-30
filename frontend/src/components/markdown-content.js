import { marked } from "marked";

const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

function element(tagName, className = "") {
  const node = document.createElement(tagName);
  node.className = className;
  return node;
}

function appendText(parent, value) {
  if (!value) return;
  const span = element("span");
  span.textContent = value;
  parent.appendChild(span);
}

function safeHref(href) {
  const value = String(href ?? "").trim();
  if (!value) return null;
  if (value.startsWith("#")) return value;
  try {
    const url = new URL(value, "https://vera.invalid");
    return SAFE_PROTOCOLS.has(url.protocol) ? value : null;
  } catch {
    return null;
  }
}

function appendInline(parent, tokens = []) {
  for (const token of tokens) {
    if (token.type === "text" || token.type === "escape") {
      if (token.tokens?.length) appendInline(parent, token.tokens);
      else appendText(parent, token.text ?? token.raw);
      continue;
    }
    if (token.type === "strong" || token.type === "em" || token.type === "del") {
      const tagName = token.type === "strong" ? "strong" : token.type === "em" ? "em" : "del";
      const node = element(tagName);
      appendInline(node, token.tokens);
      parent.appendChild(node);
      continue;
    }
    if (token.type === "codespan") {
      const code = element("code");
      code.textContent = token.text ?? "";
      parent.appendChild(code);
      continue;
    }
    if (token.type === "br") {
      parent.appendChild(element("br"));
      continue;
    }
    if (token.type === "link") {
      const href = safeHref(token.href);
      const node = element(href ? "a" : "span");
      appendInline(node, token.tokens);
      if (href) {
        node.href = href;
        if (href.startsWith("http://") || href.startsWith("https://")) {
          node.target = "_blank";
          node.rel = "noopener noreferrer";
        }
        if (token.title) node.title = token.title;
      }
      parent.appendChild(node);
      continue;
    }
    if (token.type === "image") {
      const href = safeHref(token.href);
      const node = element(href ? "a" : "span", "vera-markdown__image-link");
      node.textContent = token.text ? `图片：${token.text}` : "图片链接";
      if (href) {
        node.href = href;
        node.target = "_blank";
        node.rel = "noopener noreferrer";
      }
      parent.appendChild(node);
      continue;
    }
    if (token.type === "html") {
      appendText(parent, token.raw);
      continue;
    }
    if (token.tokens?.length) appendInline(parent, token.tokens);
    else appendText(parent, token.text ?? token.raw);
  }
}

function appendBlocks(parent, tokens = []) {
  for (const token of tokens) {
    if (token.type === "space") continue;
    if (token.type === "paragraph" || token.type === "text") {
      const paragraph = element("p");
      appendInline(paragraph, token.tokens ?? [token]);
      parent.appendChild(paragraph);
      continue;
    }
    if (token.type === "heading") {
      const heading = element(`h${Math.min(Math.max(token.depth ?? 2, 1), 6)}`);
      appendInline(heading, token.tokens);
      parent.appendChild(heading);
      continue;
    }
    if (token.type === "code") {
      const pre = element("pre");
      const code = element("code");
      code.textContent = token.text ?? "";
      if (token.lang) code.dataset.language = String(token.lang).split(/\s/u, 1)[0];
      pre.appendChild(code);
      parent.appendChild(pre);
      continue;
    }
    if (token.type === "blockquote") {
      const quote = element("blockquote");
      appendBlocks(quote, token.tokens);
      parent.appendChild(quote);
      continue;
    }
    if (token.type === "list") {
      const list = element(token.ordered ? "ol" : "ul");
      if (token.ordered && Number.isSafeInteger(Number(token.start))) list.start = Number(token.start);
      for (const item of token.items ?? []) {
        const row = element("li");
        if (item.task) {
          const marker = element("span", "vera-markdown__task");
          marker.textContent = item.checked ? "☑" : "☐";
          marker.setAttribute("aria-hidden", "true");
          row.appendChild(marker);
        }
        appendBlocks(row, item.tokens);
        list.appendChild(row);
      }
      parent.appendChild(list);
      continue;
    }
    if (token.type === "table") {
      const wrapper = element("div", "vera-markdown__table-wrap");
      const table = element("table");
      const head = element("thead");
      const headerRow = element("tr");
      for (const cell of token.header ?? []) {
        const th = element("th");
        appendInline(th, cell.tokens);
        headerRow.appendChild(th);
      }
      head.appendChild(headerRow);
      const body = element("tbody");
      for (const cells of token.rows ?? []) {
        const row = element("tr");
        for (const cell of cells) {
          const td = element("td");
          appendInline(td, cell.tokens);
          row.appendChild(td);
        }
        body.appendChild(row);
      }
      table.append(head, body);
      wrapper.appendChild(table);
      parent.appendChild(wrapper);
      continue;
    }
    if (token.type === "hr") {
      parent.appendChild(element("hr"));
      continue;
    }
    if (token.type === "html") {
      const paragraph = element("p");
      appendText(paragraph, token.raw);
      parent.appendChild(paragraph);
      continue;
    }
    const fallback = element("p");
    appendInline(fallback, token.tokens ?? [token]);
    parent.appendChild(fallback);
  }
}

export function renderMarkdownContent(host, source) {
  const content = String(source ?? "");
  host.classList.add("is-markdown");
  try {
    const fragment = element("span", "vera-markdown");
    appendBlocks(fragment, marked.lexer(content, { gfm: true, breaks: true }));
    host.replaceChildren(fragment);
  } catch {
    host.textContent = content;
  }
}
