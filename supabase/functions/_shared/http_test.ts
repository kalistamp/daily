import { cors, boundedJson, handler, authorize } from "./http.ts";
function assert(value: unknown) {
  if (!value) throw Error("Assertion failed");
}
Deno.test(
  "CORS exact origin, preflight, method and missing authentication",
  async () => {
    const origin = "https://kalistamp.github.io";
    assert(
      cors(new Request("https://test.invalid", { headers: { origin } }))[
        "Access-Control-Allow-Origin"
      ] === origin,
    );
    for (const origin of [
      "https://evil.invalid",
      "https://kalistamp.github.io.evil.invalid",
    ]) {
      let rejected = false;
      try {
        cors(new Request("https://test.invalid", { headers: { origin } }));
      } catch {
        rejected = true;
      }
      assert(rejected);
    }
    const serve = handler(async (req) => {
      await authorize(req);
      return {};
    });
    assert(
      (
        await serve(
          new Request("https://test.invalid", {
            method: "OPTIONS",
            headers: { origin },
          }),
        )
      ).status === 204,
    );
    assert(
      (
        await serve(
          new Request("https://test.invalid", {
            method: "GET",
            headers: { origin },
          }),
        )
      ).status === 405,
    );
    assert(
      (
        await serve(
          new Request("https://test.invalid", {
            method: "POST",
            headers: { origin },
            body: "{}",
          }),
        )
      ).status === 401,
    );
  },
);
Deno.test("Bounded JSON rejects oversized streams", async () => {
  assert((await boundedJson(new Response('{"ok":true}'), 100)).ok);
  let rejected = false;
  try {
    await boundedJson(new Response("x".repeat(101)), 100);
  } catch {
    rejected = true;
  }
  assert(rejected);
});
