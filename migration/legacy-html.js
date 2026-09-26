// 旧 analysis.html の分析本文を、書き換えずに構造化するための最小限の HTML 解析（依存なし）。
// 本文のテキストは原文のまま取り出す（要約・言い換えはしない）。

const VOID = new Set(["br", "hr", "img", "input", "meta", "link", "wbr"]);

export function decode(s) {
  return s.replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

// 簡易ツリー：{ tag, cls, id, children } / { text }
export function parse(html) {
  const root = { tag: "#root", cls: [], children: [] };
  const stack = [root];
  const re = /<!--[^]*?-->|<\/?([a-zA-Z0-9]+)((?:\s+[^\s=>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[0].startsWith("<!--")) continue;
    if (m[3] != null) { stack.at(-1).children.push({ text: decode(m[3]) }); continue; }
    const tag = m[1].toLowerCase();
    if (m[0].startsWith("</")) {
      const idx = stack.map(n => n.tag).lastIndexOf(tag);
      if (idx > 0) stack.length = idx;
      continue;
    }
    const attrs = m[2] ?? "";
    const cls = ((/class\s*=\s*"([^"]*)"/.exec(attrs) ?? [])[1] ?? "").split(/\s+/).filter(Boolean);
    const id = (/id\s*=\s*"([^"]*)"/.exec(attrs) ?? [])[1] ?? null;
    const node = { tag, cls, id, children: [] };
    stack.at(-1).children.push(node);
    if (!VOID.has(tag) && !m[0].endsWith("/>")) stack.push(node);
  }
  return root;
}

const has = (n, c) => n.cls?.includes(c);
// テキスト（<br> は改行、それ以外のタグは外すだけ）
export function text(n) {
  if (n.text != null) return n.text;
  if (n.tag === "br") return "\n";
  return n.children.map(text).join("");
}
const clean = s => s.replace(/[ \t\r\f\v]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{2,}/g, "\n").trim();
const find = (n, pred, out = []) => { for (const c of n.children ?? []) { if (c.tag && pred(c)) out.push(c); else if (c.tag) find(c, pred, out); } return out; };
const first = (n, pred) => find(n, pred)[0] ?? null;

function tableBlock(tableNode) {
  const rows = find(tableNode, c => c.tag === "tr");
  const cells = r => r.children.filter(c => c.tag === "th" || c.tag === "td");
  const headerRow = rows.find(r => cells(r).every(c => c.tag === "th"));
  return {
    type: "table",
    headers: headerRow ? cells(headerRow).map(c => clean(text(c))) : [],
    rows: rows.filter(r => r !== headerRow).map(r => cells(r).map(c => clean(text(c)))),
  };
}

// ブロック化。確率表示（probability-box / model-meta）は構造化しない（excluded に記録）
export function toBlocks(node, excluded = []) {
  const blocks = [];
  for (const c of node.children) {
    if (c.text != null) { const t = clean(c.text); if (t) blocks.push({ type: "text", text: t }); continue; }
    if (has(c, "probability-box") || has(c, "model-meta")) { excluded.push({ class: c.cls.join(" "), text: clean(text(c)) }); continue; }
    if (has(c, "detail-title")) blocks.push({ type: "title", text: clean(text(c)) });
    else if (has(c, "detail-sub")) blocks.push({ type: "subtitle", text: clean(text(c)) });
    else if (has(c, "detail-section-label")) blocks.push({ type: "section", text: clean(text(c)) });
    else if (has(c, "easy-summary")) {
      blocks.push({
        type: "items", title: clean(text(first(c, x => has(x, "easy-title")) ?? { text: "" })),
        items: find(c, x => has(x, "easy-item")).map(i => ({ label: clean(text(first(i, x => x.tag === "span") ?? { text: "" })), value: clean(text(first(i, x => x.tag === "strong") ?? { text: "" })) })),
      });
    } else if (has(c, "detail-grid")) {
      blocks.push({
        type: "boxes",
        boxes: find(c, x => has(x, "box")).map(b => ({
          title: clean(text(first(b, x => x.tag === "h3") ?? { text: "" })),
          paragraphs: find(b, x => x.tag === "p").map(p => clean(text(p))),
          list: find(b, x => x.tag === "li").map(li => clean(text(li))),
        })),
      });
    } else if (has(c, "h2h-analysis")) {
      blocks.push({
        type: "items", title: clean(text(first(c, x => has(x, "h2h-analysis-title")) ?? { text: "" })),
        items: find(c, x => has(x, "h2h-stat")).map(i => ({ label: clean(text(first(i, x => x.tag === "span") ?? { text: "" })), value: clean(text(first(i, x => x.tag === "strong") ?? { text: "" })) })),
        notes: [...find(c, x => has(x, "h2h-ha")), ...find(c, x => has(x, "h2h-read"))].map(n => clean(text(n))),
      });
    } else if (c.tag === "table") blocks.push(tableBlock(c));
    else if (has(c, "table-wrap")) { const t = first(c, x => x.tag === "table"); if (t) blocks.push(tableBlock(t)); }
    else if (has(c, "reason")) blocks.push({ type: "reason", text: clean(text(c)) });
    else if (has(c, "source-note")) blocks.push({ type: "note", text: clean(text(c)) });
    else if (c.tag === "h3") blocks.push({ type: "heading", text: clean(text(c)) });
    else if (c.tag === "summary") blocks.push({ type: "heading", text: clean(text(c)) });
    else if (has(c, "value-detail-body") || c.tag === "p") blocks.push({ type: "lines", lines: clean(text(c)).split("\n").filter(Boolean) });
    else blocks.push(...toBlocks(c, excluded));           // h2h・details などの入れ物は中身を順に
  }
  return blocks;
}

// 構造化したブロックのテキストを連結（原文のテキストと比べて欠落が無いか確かめる用）
export function blocksText(blocks) {
  return blocks.map(b => {
    switch (b.type) {
      case "items": return [b.title, ...b.items.flatMap(i => [i.label, i.value]), ...(b.notes ?? [])].join(" ");
      case "boxes": return b.boxes.map(x => [x.title, ...x.paragraphs, ...x.list].join(" ")).join(" ");
      case "table": return [...b.headers, ...b.rows.flat()].join(" ");
      case "lines": return b.lines.join(" ");
      default: return b.text;
    }
  }).join(" ");
}
export const normalizeText = s => s.replace(/\s+/g, "");
export const plainText = html => text(parse(html));
