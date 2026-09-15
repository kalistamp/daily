import test from "node:test";
import assert from "node:assert/strict";
import {
  calendarDay,
  countdown,
  validDate,
  entryPayload,
  sortedEntries,
  resolveSource,
} from "../src/domain.js";
import { splitJournal, normalizeDate, uuid } from "../tools/import.mjs";
import {
  validateFeed,
  retryDelay,
  cacheResult,
} from "../supabase/functions/_shared/leaderboard.mjs";
import {
  providers,
  providerRequest,
  providerText,
} from "../supabase/functions/_shared/providers.mjs";
test("calendar dates handle leap years and Los Angeles midnight", () => {
  assert.equal(validDate("2024-02-29"), true);
  assert.equal(validDate("2025-02-29"), false);
  assert.equal(calendarDay(new Date("2026-01-01T07:59:00Z")), "2025-12-31");
  assert.equal(countdown(new Date("2026-01-01T07:59:00Z")).left, 1);
  assert.equal(countdown(new Date("2024-01-01T08:00:00Z")).total, 366);
  assert.equal(countdown(new Date("2026-01-01T08:00:00Z")).left, 365);
});
test("entry validation and stable duplicate date order", () => {
  assert.throws(() =>
    entryPayload({
      archive_year: 2026,
      entry_date: "2025-01-01",
      body_md: "x",
    }),
  );
  assert.equal(
    entryPayload({
      archive_year: 2024,
      entry_date: "",
      body_md: "Unicode café 雪",
    }).entry_date,
    null,
  );
  assert.deepEqual(
    sortedEntries([
      { id: "b", entry_date: "2026-01-01", source_order: 2 },
      { id: "a", entry_date: "2026-01-01", source_order: 1 },
      { id: "c", entry_date: null, source_order: 0 },
    ]).map((e) => e.id),
    ["c", "a", "b"],
  );
});
test("legacy segmentation round trips malformed fences, dates and duplicates", () => {
  const text =
    "Routine\r\n# 2024-2-3\r\ntext ``` inline\r\n# 202-10-13\n雪\n# 2025-08-15\nend\n# 2025-08-15\nsecond";
  const { intro, entries } = splitJournal(text, "2024/test.md", 2024);
  assert.equal(intro + entries.map((e) => e._segment.raw).join(""), text);
  assert.equal(entries.length, 4);
  assert.equal(entries[0].entry_date, "2024-02-03");
  assert.equal(entries[1].entry_date, null);
  assert.equal(entries[2].archive_year, 2025);
  assert.notEqual(entries[2].id, entries[3].id);
  assert.equal(normalizeDate("2", "9", "3"), null);
  assert.equal(uuid("a"), uuid("a"));
});
test("relative private links resolve without remote execution", () => {
  assert.equal(
    resolveSource("2024/file.md", "../2023/note.md"),
    "2023/note.md",
  );
  assert.equal(resolveSource("2024/file.md", "https://example.com"), null);
  assert.equal(resolveSource(undefined, "asset.png"), "asset.png");
});
test("leaderboard validation, identity, freshness and backoff", () => {
  const feed = {
    category: "overall",
    agents: Array.from({ length: 10 }, (_, i) => ({
      id: "agent" + i,
      rank: i + 1,
      name: "Agent " + i,
      score: 100 - i,
    })),
  };
  assert.equal(validateFeed(feed).agents.length, 10);
  assert.throws(() => validateFeed({ ...feed, category: "chat" }));
  assert.throws(() =>
    validateFeed({ ...feed, agents: feed.agents.slice(0, 9) }),
  );
  assert.throws(() =>
    validateFeed({
      ...feed,
      agents: feed.agents.map((a) => ({ ...a, id: "same" })),
    }),
  );
  assert.equal(retryDelay("120"), 120000);
  assert.equal(retryDelay(null), 900000);
  assert.equal(cacheResult(null).stale, true);
  assert.equal(
    cacheResult({ expires_at: new Date(Date.now() + 10000).toISOString() })
      .stale,
    false,
  );
});
test("fixed provider endpoints and response adapters", () => {
  for (const id of Object.keys(providers)) {
    const req = providerRequest(
      id,
      "model-id",
      "synthetic-key",
      "system",
      "text",
    );
    assert.ok(req.url.startsWith("https://"));
    assert.ok(!req.url.includes("synthetic-key"));
    assert.ok(req.body);
  }
  assert.throws(() => providerRequest("evil", "m", "k", "s", "t"));
  assert.equal(
    providerText("openai", { choices: [{ message: { content: "ok" } }] }),
    "ok",
  );
  assert.equal(
    providerText("anthropic", { content: [{ type: "text", text: "ok" }] }),
    "ok",
  );
  assert.equal(
    providerText("gemini", {
      candidates: [{ content: { parts: [{ text: "ok" }] } }],
    }),
    "ok",
  );
});
