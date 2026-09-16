import { createClient } from "npm:@supabase/supabase-js@2.111.0";
export function cors(req: Request) {
  const origin = req.headers.get("origin") || "";
  const allowed = [
    "https://kalistamp.github.io",
    ...(Deno.env.get("DAILY_DEV_ORIGINS") || "").split(",").filter(Boolean),
  ];
  if (!allowed.includes(origin)) throw new Error("ORIGIN_DENIED");
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "authorization, apikey, content-type, x-client-info",
    Vary: "Origin",
    "Cache-Control": "no-store",
    "Content-Type": "application/json",
  };
}
export async function authorize(req: Request) {
  const url = Deno.env.get("SUPABASE_URL")!,
    key = Deno.env.get("SUPABASE_ANON_KEY")!,
    service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const auth = req.headers.get("authorization") || "";
  if (!/^Bearer \S+$/i.test(auth)) throw new Error("AUTH_REQUIRED");
  const userClient = createClient(url, key, {
    db: { schema: "daily" },
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await userClient.auth.getUser(auth.slice(7));
  if (error || !data.user) throw new Error("AUTH_REQUIRED");
  const gate = await userClient.rpc("journal_access");
  if (gate.error || gate.data !== true) throw new Error("ACCESS_DENIED");
  const admin = createClient(url, service, {
    db: { schema: "daily" },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return { user: data.user, admin };
}
export async function boundedJson(req: Request | Response, max = 750000) {
  if (Number(req.headers.get("content-length") || 0) > max)
    throw new Error("PAYLOAD_TOO_LARGE");
  const reader = req.body?.getReader();
  if (!reader) throw new Error("EMPTY_BODY");
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > max) throw new Error("PAYLOAD_TOO_LARGE");
      chunks.push(value);
    }
  } catch (e) {
    await reader.cancel();
    throw e;
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const c of chunks) {
    body.set(c, offset);
    offset += c.length;
  }
  return JSON.parse(new TextDecoder().decode(body));
}
export function handler(run: (req: Request) => Promise<unknown>) {
  return async (req: Request) => {
    let headers;
    try {
      headers = cors(req);
    } catch {
      return new Response(null, { status: 403 });
    }
    if (req.method === "OPTIONS")
      return new Response(null, { status: 204, headers });
    if (req.method !== "POST")
      return new Response(JSON.stringify({ error: "METHOD_NOT_ALLOWED" }), {
        status: 405,
        headers,
      });
    try {
      return new Response(JSON.stringify(await run(req)), { headers });
    } catch (e) {
      const code = e instanceof Error ? e.message : "REQUEST_FAILED";
      const status =
        code === "AUTH_REQUIRED"
          ? 401
          : code === "ACCESS_DENIED"
            ? 403
            : code === "RATE_LIMITED"
              ? 429
              : code === "PAYLOAD_TOO_LARGE"
                ? 413
                : 400;
      return new Response(
        JSON.stringify({
          error: /^[A-Z_]+$/.test(code) ? code : "REQUEST_FAILED",
        }),
        {
          status,
          headers: {
            ...headers,
            ...(status === 429 ? { "Retry-After": "3600" } : {}),
          },
        },
      );
    }
  };
}
