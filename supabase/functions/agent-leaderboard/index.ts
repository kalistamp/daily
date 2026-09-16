import { authorize, handler, boundedJson } from "../_shared/http.ts";
import {
  validateFeed,
  retryDelay,
  cacheResult,
} from "../_shared/leaderboard.mjs";
Deno.serve(
  handler(async (req) => {
    const { admin } = await authorize(req);
    const { data: cache, error } = await admin
      .from("agent_leaderboard_cache")
      .select("*")
      .eq("key", "overall")
      .single();
    if (error) throw Error("CACHE_UNAVAILABLE");
    if (Date.parse(cache.expires_at) > Date.now()) return cacheResult(cache);
    const feed = Deno.env.get("ARENA_AUTHORIZED_FEED_URL");
    // No scraper fallback: configure only a feed the owner is authorized to use.
    if (!feed)
      return {
        ...cacheResult(cache),
        unavailable_reason: "AUTHORIZED_FEED_NOT_CONFIGURED",
      };
    const url = new URL(feed);
    if (url.protocol !== "https:" || url.username || url.password)
      throw Error("FEED_CONFIGURATION_INVALID");
    const lease = await admin.rpc("claim_agent_refresh");
    if (lease.error || !lease.data) return cacheResult(cache);
    let delay = 900000;
    try {
      const token = Deno.env.get("ARENA_FEED_TOKEN");
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        signal: AbortSignal.timeout(10000),
        redirect: "error",
      });
      if (!response.ok) {
        delay = retryDelay(response.headers.get("retry-after"));
        throw Error("UPSTREAM_UNAVAILABLE");
      }
      const payload = validateFeed(await boundedJson(response, 100000));
      const now = Date.now();
      const next = {
        payload,
        fetched_at: new Date(now).toISOString(),
        expires_at: new Date(now + 900000).toISOString(),
        retry_after: null,
        lease_until: null,
      };
      const saved = await admin
        .from("agent_leaderboard_cache")
        .update(next)
        .eq("key", "overall");
      if (saved.error) throw Error("CACHE_UNAVAILABLE");
      return cacheResult(next);
    } catch {
      await admin
        .from("agent_leaderboard_cache")
        .update({
          lease_until: null,
          retry_after: new Date(Date.now() + delay).toISOString(),
        })
        .eq("key", "overall");
      return {
        ...cacheResult(cache),
        stale: true,
        unavailable_reason: "UPSTREAM_UNAVAILABLE",
      };
    }
  }),
);
