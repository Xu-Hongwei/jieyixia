const HEADERS = { "Cache-Control": "no-store" };

const PUBLIC_ORIGIN = "https://123.56.205.140";
const BACKEND_HEALTH_URL = PUBLIC_ORIGIN + "/api/healthz";
const QWEN_OPS = ["verify", "analyze", "propose"] as const;
type QwenOp = (typeof QWEN_OPS)[number];

const QWEN_KEY_HEADER = "X-JXL-Qwen-Key";
const SERVICE_HEADER = "X-JXL-Site-Service";
const SERVICE_TOKEN = Deno.env.get("JXL_SITE_SERVICE_TOKEN") ?? "";

// 后端自身上限为 8MiB；Function 只做防滥用硬顶，超出仍交给后端判定。
const MAX_BODY_BYTES = 16 * 1024 * 1024;

const EGRESS_TARGETS = [
  "https://1.1.1.1/cdn-cgi/trace",
  "https://www.cloudflare.com/cdn-cgi/trace",
  "https://checkip.amazonaws.com",
  "https://example.com",
];

const IP_LITERAL_TARGETS = [
  "http://1.1.1.1/cdn-cgi/trace",
  "https://1.0.0.1/cdn-cgi/trace",
  "https://8.8.8.8/",
  "https://223.5.5.5/",
  "https://dns.alidns.com/resolve?name=example.com&type=A",
];

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: HEADERS });
}

function methodNotAllowed(allow: string): Response {
  return new Response(JSON.stringify({ ok: false, code: "method_not_allowed", message: "方法不允许" }), {
    status: 405,
    headers: { ...HEADERS, Allow: allow, "Content-Type": "application/json" },
  });
}

function upstreamFailure(error: unknown): Response {
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return json({ ok: false, code: "upstream_timeout", message: "后端响应超时，请稍后重试。" }, 504);
  }
  return json({ ok: false, code: "upstream_unreachable", message: "暂时无法连接后端服务，请稍后重试。" }, 502);
}

function passthrough(response: Response, text: string): Response {
  const headers: Record<string, string> = { ...HEADERS };
  const contentType = response.headers.get("content-type");
  if (contentType) headers["Content-Type"] = contentType;
  const requestId = response.headers.get("x-request-id");
  if (requestId) headers["X-Request-Id"] = requestId;
  return new Response(text, { status: response.status, headers });
}

function qwenOp(pathname: string): QwenOp | null {
  const match = pathname.match(/\/api\/qwen\/([A-Za-z]+)\/?$/);
  if (!match) return null;
  const op = match[1] as QwenOp;
  return (QWEN_OPS as readonly string[]).includes(op) ? op : null;
}

async function health(request: Request): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed("GET");
  try {
    const response = await fetch(BACKEND_HEALTH_URL, {
      redirect: "error",
      signal: AbortSignal.timeout(10000),
      headers: { "Accept": "application/json" },
    });
    return passthrough(response, await response.text());
  } catch (error) {
    return upstreamFailure(error);
  }
}

async function qwen(request: Request, op: QwenOp): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed("POST");
  if (!SERVICE_TOKEN) {
    return json({ ok: false, code: "service_not_configured", message: "站点服务尚未配置，请联系站长。" }, 503);
  }

  const key = request.headers.get(QWEN_KEY_HEADER);
  let body: ArrayBuffer | undefined;
  if (request.body) {
    body = await request.arrayBuffer();
    if (body.byteLength > MAX_BODY_BYTES) {
      return json({ ok: false, code: "payload_too_large", message: "请求体超出上限。" }, 413);
    }
    if (body.byteLength === 0) body = undefined;
  }

  const headers: Record<string, string> = {
    "Accept": "application/json",
    [SERVICE_HEADER]: SERVICE_TOKEN,
  };
  const contentType = request.headers.get("content-type");
  if (contentType) headers["Content-Type"] = contentType;
  if (key) headers[QWEN_KEY_HEADER] = key;

  const signal = AbortSignal.timeout(125000);
  try {
    const response = await fetch(`${PUBLIC_ORIGIN}/api/qwen/${op}`, {
      method: "POST",
      redirect: "error",
      signal,
      headers,
      body,
    });
    return passthrough(response, await response.text());
  } catch (error) {
    return upstreamFailure(error);
  }
}

async function probe(target: string) {
  const startedAt = Date.now();
  try {
    const response = await fetch(target, {
      redirect: "manual",
      signal: AbortSignal.timeout(6000),
      headers: { "Accept": "*/*" },
    });
    const text = (await response.text()).slice(0, 160);
    return {
      target,
      ok: true,
      status: response.status,
      elapsedMs: Date.now() - startedAt,
      sample: text.trim(),
    };
  } catch (error) {
    return {
      target,
      ok: false,
      error: error instanceof Error ? error.name : "fetch_failed",
      elapsedMs: Date.now() - startedAt,
    };
  }
}

async function diagnostics(request: Request, url: URL): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed("GET");

  const action = url.searchParams.get("action") ?? "ping";

  if (action === "ping") {
    return json({
      ok: true,
      test: "sites-function",
      runtime: "edge",
      now: new Date().toISOString(),
    });
  }

  if (action === "egress-probe" || action === "egress-ip-literals") {
    const startedAt = Date.now();
    const targets = action === "egress-ip-literals" ? IP_LITERAL_TARGETS : EGRESS_TARGETS;
    const results = await Promise.all(targets.map(probe));
    return json({
      ok: results.some((item) => item.ok),
      elapsedMs: Date.now() - startedAt,
      results,
    });
  }

  if (action === "backend-health") {
    const startedAt = Date.now();
    try {
      const response = await fetch(BACKEND_HEALTH_URL, {
        redirect: "error",
        signal: AbortSignal.timeout(15000),
        headers: { "Accept": "application/json" },
      });
      const text = (await response.text()).slice(0, 500);
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        // keep raw text when upstream is not JSON
      }
      return json({
        ok: response.ok,
        target: BACKEND_HEALTH_URL,
        upstreamStatus: response.status,
        upstreamServer: response.headers.get("server"),
        elapsedMs: Date.now() - startedAt,
        body,
      });
    } catch (error) {
      return json({
        ok: false,
        target: BACKEND_HEALTH_URL,
        error: error instanceof Error ? error.name : "fetch_failed",
        elapsedMs: Date.now() - startedAt,
      });
    }
  }

  return json({ ok: false, code: "not_found", message: "接口不存在" }, 404);
}

export async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path.endsWith("/api/healthz")) return health(request);

  if (path.includes("/api/")) {
    const op = qwenOp(path);
    if (op) return qwen(request, op);
    return json({ ok: false, code: "not_found", message: "接口不存在" }, 404);
  }

  return diagnostics(request, url);
}
