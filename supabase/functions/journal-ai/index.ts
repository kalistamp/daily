import { authorize, handler, boundedJson } from "../_shared/http.ts";
import {
  providers,
  providerRequest,
  providerText,
} from "../_shared/providers.mjs";
import {
  monthlyPrompt,
  FOLLOWUP_PROMPT,
  REFLECTION_PROMPT,
} from "../_shared/reflection.mjs";
Deno.serve(
  handler(async (req) => {
    const { user, admin } = await authorize(req);
    const input = await boundedJson(req);
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw Error("INVALID_REQUEST");
    const provider = String(input.provider || ""),
      model = String(input.model || ""),
      p = providers[provider as keyof typeof providers];
    if (!p) throw Error("INVALID_PROVIDER");
    const key = Deno.env.get(p.key);
    if (!key) throw Error("PROVIDER_NOT_CONFIGURED");
    const models = JSON.parse(Deno.env.get("DAILY_ALLOWED_MODELS") || "{}");
    if (!Array.isArray(models[provider]) || !models[provider].includes(model))
      throw Error("MODEL_NOT_ALLOWED");
    if (
      !Array.isArray(input.entries) ||
      (!input.entries.length && input.operation !== "reflect") ||
      input.entries.length > 500 ||
      input.entries.some(
        (e: unknown) =>
          !e ||
          typeof e !== "object" ||
          !("text" in e) ||
          typeof e.text !== "string" ||
          !("date" in e) ||
          typeof e.date !== "string",
      )
    )
      throw Error("INVALID_ENTRIES");
    if (
      input.operation &&
      !["followups", "monthly", "reflect"].includes(input.operation)
    )
      throw Error("INVALID_OPERATION");
    const quota = await admin.rpc("claim_ai_request", { owner_id: user.id });
    if (quota.error) throw Error("RATE_LIMIT_UNAVAILABLE");
    if (!quota.data) throw Error("RATE_LIMITED");
    const system =
      input.operation === "followups"
        ? FOLLOWUP_PROMPT
        : input.operation === "reflect"
          ? REFLECTION_PROMPT
          : monthlyPrompt(input.advice || input.focus);
    const task = input.operation==='reflect'?String(input.question||'Respond to my reflection.').slice(0,10000):
      input.operation === "followups"
        ? 'Return JSON only: {"followups":[{"q":"question","why":"reason"}],"claims":[{"sourceDate":"YYYY-MM-DD","quote":"exact substring of entry","confidence":"low/medium/high"}]}. Give up to 8 useful questions and 12 testable claims.'
        : String(input.focus || "Write a reflective report in Markdown.").slice(
            0,
            10000,
          );
    const text = JSON.stringify({
      task,
      report: String(input.report || "").slice(0, 100000),
      reflection: String(input.reflection || "").slice(0, 100000),
      question: String(input.question || "").slice(0, 10000),
      conversation: Array.isArray(input.conversation)
        ? input.conversation
            .slice(-16)
            .filter(
              (t: { role?: string; content?: string }) =>
                t && ["user", "assistant"].includes(t.role || "") &&
                typeof t.content === "string",
            )
        : [],
      established_context: input.context?.items || [],
      period: input.month || null,
      entries: input.entries,
    });
    const request = providerRequest(provider, model, key, system, text);
    const headers = new Headers({ "Content-Type": "application/json" });
    for (const [k, v] of Object.entries(request.headers))
      if (v) headers.set(k, String(v));
    const response = await fetch(request.url, {
      method: "POST",
      headers,
      body: JSON.stringify(request.body),
      redirect: "error",
      signal: AbortSignal.timeout(90000),
    });
    if (!response.ok)
      throw Error(
        response.status === 429 ? "RATE_LIMITED" : "PROVIDER_REQUEST_FAILED",
      );
    return {
      text: providerText(provider, await boundedJson(response, 2000000)),
    };
  }),
);
