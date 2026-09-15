import { createClient } from "@supabase/supabase-js";
export const config = {
  url: "https://baiojghilzxhkebfblzv.supabase.co",
  key: "sb_publishable_nfLVr5Krdld9pxxr4f2CYQ_bsn0TNxx",
};
export const client = createClient(config.url, config.key, {
  db: { schema: "daily" },
  auth: {
    storage: sessionStorage,
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});
const check = ({ data, error }) => {
  if (error) throw new Error(error.message);
  return data;
};
export class CloudBackend {
  constructor(user) {
    this.user = user;
    this.local = false;
    this.revision = 0;
  }
  async all(table) {
    const rows = [];
    for (let from = 0; ; from += 400) {
      let query = client
          .from(table)
          .select("*")
          .eq("user_id", this.user.id)
          .order(
            table === "journal_years"
              ? "year"
              : table === "daily_items"
                ? "entity_id"
                : "id",
          );
      if (table === "daily_items") query = query.order("entity_type");
      const page = check(await query.range(from, from + 399));
      rows.push(...page);
      if (page.length < 400) return rows;
    }
  }
  async load() {
    const imports = await this.all("journal_imports");
    const active = new Set(
      imports.filter((r) => r.status === "active").map((r) => r.id),
    );
    const data = {};
    for (const kind of ["entries", "documents", "years", "assets"])
      data[kind] = (await this.all("journal_" + kind)).filter(
        (r) => !r.import_batch || active.has(r.import_batch),
      );
    return data;
  }
  async save(kind, row, expected) {
    await this.assertSession();
    const table = "journal_" + kind;
    let q;
    if (expected) {
      q = client
        .from(table)
        .update(row)
        .eq(kind === "years" ? "year" : "id", row.id || row.year)
        .eq("revision", expected);
    } else q = client.from(table).insert({ ...row, user_id: this.user.id });
    const saved = check(await q.select());
    if (saved.length !== 1)
      throw new Error(
        "This record changed elsewhere. Your draft is still open. Reload before saving again.",
      );
    return saved[0];
  }
  async history(kind, id) {
    return check(
      await client
        .from("journal_revisions")
        .select("*")
        .eq("entity", "journal_" + kind)
        .eq("entity_id", String(id))
        .order("revision", { ascending: false }),
    );
  }
  async asset(row) {
    const blob = check(
      await client.storage.from("daily-journal").download(row.object_path),
    );
    return blob;
  }
  async reports() {
    check(await client.rpc("ensure_daily_state"));
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = check(
        await client.from("daily_sync_state").select("revision").eq("user_id", this.user.id).single(),
      );
      const rows = await this.all("daily_items");
      const after = check(
        await client.from("daily_sync_state").select("revision").eq("user_id", this.user.id).single(),
      );
      if (before.revision === after.revision) {
        this.revision = Number(after.revision);
        return rows;
      }
    }
    throw new Error("Reports are changing in another session. Please refresh.");
  }
  async saveReport(type, id, data, remove = false) {
    await this.assertSession();
    const result = check(
      await client.rpc("apply_daily_changes", {
        expected_revision: this.revision,
        changes: [
          {
            entity_type: type,
            entity_id: id,
            action: remove ? "delete" : "upsert",
            data,
          },
        ],
      }),
    );
    this.revision = Number(result);
  }
  async assertSession() {
    const {
      data: { session },
    } = await client.auth.getSession();
    if (!session || session.user.id !== this.user.id)
      throw new Error("Session changed. Please sign in again.");
  }
  async edge(name, body) {
    await this.assertSession();
    const result = await client.functions.invoke(name, { body });
    if (result.error?.context instanceof Response) {
      const payload = await result.error.context.json().catch(() => ({}));
      if (typeof payload.error === "string")
        throw new Error(payload.error.replaceAll("_", " ").toLowerCase());
    }
    return check(result);
  }
}
export class LocalBackend {
  constructor() {
    this.user = { id: "local-review" };
    this.local = true;
  }
  async request(route, body) {
    const response = await fetch("/__review/" + route, {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    const data = await response.json();
    if (!response.ok)
      throw new Error(data.error || "Local review unavailable.");
    return data;
  }
  load() {
    return this.request("data");
  }
  save(kind, row, expected) {
    return this.request("save", { kind, row, expected });
  }
  history(kind, id) {
    return this.request(
      "history?kind=" + kind + "&id=" + encodeURIComponent(id),
    );
  }
  async asset(row) {
    const response = await fetch("/__review/asset?id=" + row.id, {
      cache: "no-store",
    });
    if (!response.ok) throw new Error("Asset unavailable.");
    return response.blob();
  }
  reports() {
    return this.request("reports");
  }
  saveReport(type, id, data, remove = false) {
    return this.request("report", { type, id, data, remove });
  }
  async edge() {
    throw new Error("Cloud services are disabled in local review.");
  }
}
