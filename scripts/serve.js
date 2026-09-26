// 開発確認用の静的ファイルサーバー（依存なし）。GitHub Pages と同じくリポジトリ直下を配信する。
// 使い方: node scripts/serve.js [ポート]   → http://localhost:8123/analysis-v2.html

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, normalize, extname } from "node:path";
import { ROOT } from "./load-node.js";

const PORT = Number(process.argv[2] ?? process.env.PORT ?? 8123);
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".md": "text/plain; charset=utf-8",
};

createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    if (path.endsWith("/")) path += "index.html";
    const file = normalize(join(ROOT, path));
    if (!file.startsWith(ROOT) || file.includes(`${join(ROOT, ".git")}`)) { res.writeHead(403).end(); return; }
    if (!(await stat(file)).isFile()) throw new Error("not a file");
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
  }
}).listen(PORT, () => console.log(`http://localhost:${PORT}/analysis-v2.html`));
