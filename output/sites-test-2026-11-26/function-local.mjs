import { pathToFileURL } from "node:url";

const canaryKey = "sk-LEAKCANARYKEY0001";
const canaryBody = JSON.stringify({ canary: "BODYCANARY7788" });
const base = "http://127.0.0.1:8010/functions/v1/app";

globalThis.Deno = { env: { get: (name) => process.env[name] } };
const { handler } = await import(pathToFileURL("E:/qoder/frontend/functions/handler.ts").href);

const rows = [];
async function call(name, method, path, headers = {}, body) {
  const res = await handler(new Request(base + path, { method, headers, body }));
  const text = await res.text();
  rows.push({ name, status: res.status, type: res.headers.get("content-type"), body: text.slice(0, 400) });
  return { status: res.status, text };
}

const health = await call("GET /api/healthz", "GET", "/api/healthz");
await call("POST /api/healthz", "POST", "/api/healthz");
await call("POST /api/qwen/verify 无 Key", "POST", "/api/qwen/verify", { "Content-Type": "application/json" });
await call("POST /api/qwen/verify 金丝雀 Key", "POST", "/api/qwen/verify",
  { "Content-Type": "application/json", "X-JXL-Qwen-Key": canaryKey });
await call("POST /api/qwen/analyze 金丝雀正文", "POST", "/api/qwen/analyze",
  { "Content-Type": "application/json", "X-JXL-Qwen-Key": canaryKey }, canaryBody);
await call("GET /api/unknown", "GET", "/api/unknown");
await call("GET 诊断 ping", "GET", "?action=ping");

const problems = [];
if (health.status !== 200) problems.push("healthz 非 200");
let parsed = null;
try { parsed = JSON.parse(health.text); } catch {}
if (!parsed || typeof parsed.model_ready !== "boolean") problems.push("healthz 未原样返回 model_ready");
if (rows[1].status !== 405) problems.push("healthz POST 未 405");
if (rows[2].status !== 401 || !rows[2].body.includes("qwen_key_invalid")) problems.push("无 Key 未返回 401 qwen_key_invalid");
if (rows[3].status !== 403 || !rows[3].body.includes("qwen_key_denied")) problems.push("Key 未透传到后端");
if (rows[4].status !== 422 || !rows[4].body.includes("canary")) problems.push("正文未透传到后端");
if (rows[5].status !== 404) problems.push("未知 api 路径未 404");
if (rows[6].status !== 200 || !rows[6].body.includes("sites-function")) problems.push("诊断 ping 回归失败");
for (const row of rows) if (row.body.includes(process.env.JXL_SITE_SERVICE_TOKEN)) problems.push("响应泄露服务凭证");

console.log(JSON.stringify({ problems, rows }, null, 2));
process.exit(problems.length ? 1 : 0);
