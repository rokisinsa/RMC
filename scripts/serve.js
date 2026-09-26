// 開発確認用の静的ファイルサーバー（依存なし）。GitHub Pages と同じくリポジトリ直下を配信する。
// 使い方: node scripts/serve.js [ポート] [--block=analysis.html,analysis.js]   → http://localhost:8123/analysis-v2.html
//   --block に指定したファイルは 404 を返す（V2 が旧ファイルなしで動くかの確認用）

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, normalize, extname } from "node:path";
import { ROOT } from "./load-node.js";

const args = process.argv.slice(2);
const PORT = Number(args.find(a => /^\d+$/.test(a)) ?? process.env.PORT ?? 8123);
const BLOCK = new Set((args.find(a => a.startsWith("--block="))?.slice(8) ?? process.env.RMC_BLOCK ?? "")
  .split(",").filter(Boolean).map(p => "/" + p.replace(/^\/+/, "")));
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".md": "text/plain; charset=utf-8",
};

createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    if (path.endsWith("/")) path += "index.html";
    if (BLOCK.has(path)) { console.log(`[blocked] ${path}`); res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("blocked"); return; }
    const file = normalize(join(ROOT, path));
    if (!file.startsWith(ROOT) || file.includes(`${join(ROOT, ".git")}`)) { res.writeHead(403).end(); return; }
    if (!(await stat(file)).isFile()) throw new Error("not a file");
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
  }
}).listen(PORT, () => console.log(`http://localhost:${PORT}/analysis-v2.html${BLOCK.size ? `（参照不能にしたファイル: ${[...BLOCK].join(", ")}）` : ""}`));
