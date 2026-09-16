export function validateFeed(value) {
  if (
    value?.category !== "overall" ||
    !Array.isArray(value.agents) ||
    value.agents.length < 10
  )
    throw Error("INVALID_FEED");
  const agents = value.agents.slice(0, 10).map((a, i) => {
    if (
      a.rank !== i + 1 ||
      typeof a.id !== "string" ||
      !a.id ||
      typeof a.name !== "string" ||
      !a.name.trim() ||
      a.name.length > 180 ||
      !(a.score == null || Number.isFinite(a.score))
    )
      throw Error("INVALID_FEED");
    return { id: a.id, rank: a.rank, name: a.name, score: a.score ?? null };
  });
  if (new Set(agents.map((a) => a.id)).size !== 10) throw Error("INVALID_FEED");
  if (value.source_date && !/^\d{4}-\d{2}-\d{2}$/.test(value.source_date))
    throw Error("INVALID_FEED");
  return { agents, source_date: value.source_date || null };
}
export function retryDelay(value, now = Date.now()) {
  const seconds = Number(value);
  const delay =
    value && Number.isFinite(seconds)
      ? seconds * 1000
      : Date.parse(value || "") - now;
  return Math.max(
    60000,
    Math.min(86400000, Number.isFinite(delay) ? delay : 900000),
  );
}
export function cacheResult(cache, now = Date.now()) {
  return {
    agents: cache?.payload?.agents || [],
    source_date: cache?.payload?.source_date || null,
    fetched_at: cache?.fetched_at || null,
    stale: !(Date.parse(cache?.expires_at) > now),
    source: "https://arena.ai/leaderboard/agent",
  };
}
