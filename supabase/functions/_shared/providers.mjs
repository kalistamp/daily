export const providers = {
  openai: {
    url: "https://api.openai.com/v1/chat/completions",
    key: "OPENAI_API_KEY",
  },
  anthropic: {
    url: "https://api.anthropic.com/v1/messages",
    key: "ANTHROPIC_API_KEY",
    type: "anthropic",
  },
  gemini: {
    url: "https://generativelanguage.googleapis.com/v1beta/models/",
    key: "GOOGLE_API_KEY",
    type: "google",
  },
  groq: {
    url: "https://api.groq.com/openai/v1/chat/completions",
    key: "GROQ_API_KEY",
  },
  cerebras: {
    url: "https://api.cerebras.ai/v1/chat/completions",
    key: "CEREBRAS_API_KEY",
  },
  cohere: {
    url: "https://api.cohere.com/v2/chat",
    key: "COHERE_API_KEY",
    type: "cohere",
  },
  mistral: {
    url: "https://api.mistral.ai/v1/chat/completions",
    key: "MISTRAL_API_KEY",
  },
  openrouter: {
    url: "https://openrouter.ai/api/v1/chat/completions",
    key: "OPENROUTER_API_KEY",
  },
  huggingface: {
    url: "https://router.huggingface.co/v1/chat/completions",
    key: "HUGGINGFACE_API_KEY",
  },
};
export function providerRequest(provider, model, key, system, text) {
  const p = providers[provider];
  if (!p || typeof model !== "string" || !model || model.length > 200)
    throw Error("INVALID_PROVIDER_OR_MODEL");
  if (p.type === "anthropic")
    return {
      url: p.url,
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: {
        model,
        system,
        max_tokens: 8000,
        messages: [{ role: "user", content: text }],
      },
    };
  if (p.type === "google")
    return {
      url: p.url + encodeURIComponent(model) + ":generateContent",
      headers: { "x-goog-api-key": key },
      body: {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text }] }],
        generationConfig: { maxOutputTokens: 8000 },
      },
    };
  return {
    url: p.url,
    headers: { Authorization: `Bearer ${key}` },
    body: {
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: text },
      ],
      ...(provider === "openai"
        ? { max_completion_tokens: 8000 }
        : { max_tokens: 8000 }),
    },
  };
}
export function providerText(provider, payload) {
  const type = providers[provider]?.type;
  const text =
    type === "cohere"
      ? payload.message?.content
          ?.filter((p) => p.type === "text")
          .map((p) => p.text)
          .join("\n")
      : type === "anthropic"
        ? payload.content
            ?.filter((p) => p.type === "text")
            .map((p) => p.text)
            .join("\n")
        : type === "google"
          ? payload.candidates?.[0]?.content?.parts
              ?.map((p) => p.text || "")
              .join("\n")
          : payload.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim())
    throw Error("EMPTY_PROVIDER_RESPONSE");
  return text;
}
