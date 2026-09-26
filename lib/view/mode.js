// 実行モードの判定。development（ローカル確認環境）以外はすべて production として扱う。
// ④のデモ（架空データ）は development でしか有効にならない。production では URL に demo を付けても無視する。

const DEV_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function resolveMode(url) {
  const u = typeof url === "string" ? new URL(url) : url;
  const host = u.hostname;
  const development = u.protocol === "http:" && (DEV_HOSTS.has(host) || host.endsWith(".localhost"));
  const requested = u.searchParams.get("demo");
  return {
    mode: development ? "development" : "production",
    demo: development && requested === "pro_edge",
    demo_requested_but_ignored: !development && requested != null,
  };
}

// 二重の安全装置：production で架空データを含む表示モデルを作ろうとしたら止める
export function assertNoDemoInProduction(mode, dataset) {
  if (mode.mode === "production" && (mode.demo || dataset?.__demo === true)) {
    throw new Error("production では架空のデモデータを表示できません");
  }
}
