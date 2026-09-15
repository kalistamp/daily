import {
  DEFAULT_ADVICE,
  establishedContext,
} from "../supabase/functions/_shared/reflection.mjs";

export function mountInterrogation({
  host,
  backend,
  rows,
  journal,
  year,
  esc,
  icon,
  markdown,
  notice,
  modal,
  download,
  manageReport,
  refreshIcons,
  setDirty,
  isCurrent,
}) {
  const now = new Date(),
    month = `${year}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  let selected,
    working = false,
    draftDirty = false;
  let editVersion=0;
  const available = rows
    .filter(
      (r) =>
        r.entity_type === "report" &&
        String(r.data.month || "").startsWith(String(year)),
    )
    .sort((a, b) =>
      String(b.data.generatedAt || "").localeCompare(
        String(a.data.generatedAt || ""),
      ),
    );
  host.innerHTML = `<div class="viewhead"><div><h2>Self-interrogation</h2><p>${year} · monthly reports & open reflection</p></div><div class="controls"><button id="reflection-new">${icon("plus")}Open reflection</button><button id="monthly-new" class="primary">${icon("plus")}Monthly report</button></div></div><div class="interrogation-layout"><aside class="reflection-history" aria-label="Reflection history"><h3>History</h3><div id="reflection-history-list"></div><button id="advice-directive">Advice directive</button></aside><section id="reflection-workspace" class="reflection-workspace"></section></div>`;
  const workspace = host.querySelector("#reflection-workspace");
  const advice = () =>
    rows.find((r) => r.entity_type === "prompt" && r.entity_id === "settings")
      ?.data?.advice || DEFAULT_ADVICE;
  function changes() {
    editVersion++;
    draftDirty = true;
    setDirty(true);
    const status = workspace.querySelector("#reflection-status");
    if (status) status.textContent = "Unsaved";
  }
  function discard() {
    if (working) {
      notice("Wait for the current request to finish.");
      return false;
    }
    if (draftDirty && !confirm("Discard unsaved reflection changes?"))
      return false;
    draftDirty = false;
    setDirty(false);
    return true;
  }
  function context() {
    return establishedContext(rows);
  }
  function replaceRow(id, value) {
    const row = { entity_type: "report", entity_id: id, data: value };
    const i = rows.findIndex(
      (r) => r.entity_type === "report" && r.entity_id === id,
    );
    if (i < 0) rows.push(row);
    else rows[i] = row;
    const j = available.findIndex((r) => r.entity_id === id);
    if (j < 0) available.unshift(row);
    else available[j] = row;
    return row;
  }
  function history() {
    const list = host.querySelector("#reflection-history-list");
    list.innerHTML = available.length
      ? ""
      : '<p class="muted">No saved reflections yet.</p>';
    for (const item of available) {
      const button = document.createElement("button");
      button.className =
        "history-item" +
        (item.entity_id === selected?.entity_id ? " active" : "");
      button.innerHTML = `<strong>${esc(item.data.title || item.data.month)}</strong><small>${item.data.kind === "reflection" ? "Open reflection" : "Monthly report"}${item.data.followups?.length ? " · " + item.data.followups.filter((f) => f.a?.trim()).length + "/" + item.data.followups.length + " answered" : ""}</small>`;
      button.onclick = () => {
        if (discard()) show(item);
      };
      list.append(button);
    }
    let select=host.querySelector('#reflection-history-select');
    if(!select){select=document.createElement('select');select.id='reflection-history-select';select.className='history-select';select.setAttribute('aria-label','Saved reflections');list.before(select);}
    select.innerHTML=available.length?available.map(r=>`<option value="${esc(r.entity_id)}" ${r.entity_id===selected?.entity_id?'selected':''}>${esc(r.data.title||r.data.month)}</option>`).join(''):'<option>No saved reflections</option>';
    select.onchange=()=>{const row=available.find(r=>r.entity_id===select.value);if(row&&discard())show(row);else select.value=selected?.entity_id||'';};
  }
  function draft() {
    if (!selected) return null;
    const r = structuredClone(selected.data);
    r.title = workspace.querySelector("#reflection-title")?.value || r.title;
    r.reflection = workspace.querySelector("#reflection-notes")?.value || "";
    r.reflectionUpdatedAt = new Date().toISOString();
    r.generatedAt ||= new Date().toISOString();
    workspace.querySelectorAll("[data-answer]").forEach((el) => {
      const f = r.followups[Number(el.dataset.answer)];
      if (f.a !== el.value) {
        f.a = el.value;
        f.answeredAt = new Date().toISOString();
      }
    });
    return r;
  }
  async function save() {
    if (!selected) return;
    if(working)return;
    working=true;
    const stamp=editVersion;
    const value = draft();
    const id = selected.entity_id;
    const b = workspace.querySelector("#reflection-save");
    if (b) b.disabled = true;
    try {
      await backend.saveReport("report", id, value);
      if (!isCurrent()) return;
      selected = replaceRow(id, value);
      draftDirty = stamp!==editVersion;
      setDirty(draftDirty);
      workspace.querySelector("#reflection-status").textContent = draftDirty?'Unsaved':'Saved';
      history();
    } catch (e) {
      notice(e.message);
      throw e;
    } finally {
      working=false;
      if (b) b.disabled = false;
    }
  }
  function show(item) {
    selected = { ...item, data: structuredClone(item.data) };
    draftDirty = false;
    setDirty(false);
    const r = selected.data;
    workspace.innerHTML = `<header class="reflection-heading"><div><h2>${esc(r.title || r.month)}</h2><p class="muted">${esc(r.month)}${r.provider ? " · " + esc(r.provider) + " · " + esc(r.model) : ""}${r.entryCount != null ? " · " + r.entryCount + " entries" : ""}</p></div><div class="controls"><button id="reflection-export" title="Export reflection" aria-label="Export reflection">${icon("download")}</button>${r.kind !== "reflection" ? '<button id="report-rewrite">Regenerate with answers</button><button id="report-questions">Ask follow-ups</button>' : ""}</div></header>${r.report ? '<article class="markdown monthly-report" id="monthly-report"></article>' : ""}<section class="reflection-writing"><div class="section-heading"><h3>Your answers & reflections</h3><small id="reflection-status">${r.generatedAt ? "Saved" : "New reflection"}</small></div>${r.kind === "reflection" ? `<label>Title<input id="reflection-title" value="${esc(r.title || "")}" maxlength="180"></label>` : ""}<label class="sr-only" for="reflection-notes">Your reflection</label><textarea id="reflection-notes" rows="8" placeholder="What keeps coming back to you?">${esc(r.reflection || "")}</textarea><div class="controls"><button id="reflection-save" class="primary">${icon("save")}Save reflection</button><button id="reflection-ask">Interrogate this</button></div></section><section id="reflection-questions"></section><section id="reflection-conversation"></section>`;
    if (r.report)
      markdown(workspace.querySelector("#monthly-report"), r.report);
    workspace.querySelector("#reflection-notes").oninput = changes;
    const title = workspace.querySelector("#reflection-title");
    if (title) title.oninput = changes;
    const questions = workspace.querySelector("#reflection-questions");
    if (r.followups?.length) {
      questions.innerHTML =
        '<div class="section-heading"><h3>Follow-up questions</h3><small>Your answers inform future reports</small></div>';
      for (const [i, f] of r.followups.entries()) {
        const label = document.createElement("label");
        label.className = "followup";
        label.innerHTML = `<span>${esc(f.q)}</span>${f.why ? `<small>${esc(f.why)}</small>` : ""}<textarea aria-label="${esc(f.q)}" data-answer="${i}" rows="3">${esc(f.a || "")}</textarea>`;
        label.querySelector("textarea").oninput = changes;
        questions.append(label);
      }
    }
    const conversation = workspace.querySelector("#reflection-conversation");
    if (r.conversation?.length) {
      conversation.innerHTML = "<h3>Open interrogation</h3>";
      for (const turn of r.conversation) {
        const el = document.createElement("article");
        el.className = "conversation-turn " + turn.role;
        el.innerHTML = `<small>${turn.role === "user" ? "You" : "Reflection partner"}</small><div class="markdown"></div>`;
        markdown(el.querySelector(".markdown"), turn.content);
        conversation.append(el);
      }
    }
    workspace.querySelector("#reflection-save").onclick = () =>
      save().catch(() => {});
    workspace.querySelector("#reflection-export").onclick = () =>
      download(
        new Blob([JSON.stringify(draft(), null, 2)], {
          type: "application/json",
        }),
        `${r.month}-private-reflection.json`,
      );
    workspace.querySelector("#reflection-ask").onclick = () =>
      conversationDialog();
    workspace
      .querySelector("#report-rewrite")
      ?.addEventListener("click", () => generateDialog(true));
    workspace
      .querySelector("#report-questions")
      ?.addEventListener("click", () =>
        followups().catch((e) => notice(e.message)),
      );
    history();
    if(r.report&&manageReport){const manage=document.createElement('button');manage.textContent='Manage report';manage.onclick=()=>{if(discard())manageReport(selected);};workspace.querySelector('.reflection-heading .controls').append(manage);}
    refreshIcons?.();
  }
  function newReflection() {
    if (!discard()) return;
    const id = crypto.randomUUID();
    show({
      entity_id: id,
      data: {
        id,
        kind: "reflection",
        title: "Open reflection",
        month,
        reflection: "",
        followups: [],
        conversation: [],
      },
    });
    workspace.querySelector("#reflection-notes").focus();
  }
  async function request(operation, payload, message) {
    if (working) throw Error("A request is already running.");
    if (!confirm(message)) return null;
    working = true;
    try {
      const result = await backend.edge("journal-ai", {
        operation,
        ...payload,
      });
      if (!isCurrent()) return null;
      return result;
    } finally {
      working = false;
    }
  }
  function selectedEntries(start, end) {
    return journal.entries
      .filter(
        (r) =>
          !r.deleted_at &&
          r.entry_date &&
          r.entry_date >= start &&
          r.entry_date <= end,
      )
      .map((r) => ({ date: r.entry_date, title: r.title, text: r.body_md }));
  }
  function modelFields(provider = "openai", model = "") {
    return `<label>Provider<select name="provider">${["openai", "anthropic", "gemini", "groq", "cerebras", "cohere", "mistral", "openrouter", "huggingface"].map((p) => `<option ${p === provider ? "selected" : ""}>${p}</option>`).join("")}</select></label><label>Model<input name="model" value="${esc(model)}" required placeholder="Approved model ID"></label>`;
  }
  function generateDialog(rewrite = false) {
    if (draftDirty) {
      notice("Save your reflection and answers first.");
      return;
    }
    const current = rewrite ? selected : null;
    const target = current?.data.month || month;
    modal(
      rewrite ? "Regenerate with your answers" : "Monthly self-interrogation",
      `<form id="interrogation-generate"><div class="fields"><label>Month<input type="month" name="month" value="${target}" required></label><div></div><label>From<input type="date" name="start" value="${current?.data.rangeStart || target + "-01"}" required></label><label>Through<input type="date" name="end" value="${current?.data.rangeEnd || monthEnd(target)}" required></label>${modelFields(current?.data.provider, current?.data.model)}<label class="full checkbox"><input type="checkbox" name="context" checked>Include my earlier answers and reflections</label></div><p class="error"></p></form>`,
      `<button class="primary" form="interrogation-generate">${rewrite ? "Regenerate report" : "Generate monthly report"}</button>`,
    );
    const form = document.querySelector("#interrogation-generate");
    form.elements.month.onchange = () => {
      form.elements.start.value = form.elements.month.value + "-01";
      form.elements.end.value = monthEnd(form.elements.month.value);
    };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const p = Object.fromEntries(new FormData(form));
      const entries = selectedEntries(p.start, p.end);
      if (!entries.length) {
        form.querySelector(".error").textContent =
          "No dated entries in this range.";
        return;
      }
      const established = p.context
        ? context()
        : { items: [], included: 0, total: 0 };
      const b = document.querySelector("button[form=interrogation-generate]");
      b.disabled = true;
      try {
        const result = await request(
          "monthly",
          { ...p, entries, advice: advice(), context: established },
          `Send ${entries.length} entries and ${established.included} earlier answers/reflections to ${p.provider} (${p.model})?`,
        );
        if (!result) return;
        const id = current?.entity_id || crypto.randomUUID();
        const value = {
          ...current?.data,
          id,
          kind: "monthly",
          month: p.month,
          report: result.text,
          provider: p.provider,
          model: p.model,
          entryCount: entries.length,
          rangeStart: p.start,
          rangeEnd: p.end,
          requestedStart: p.start,
          requestedEnd: p.end,
          generatedAt: current?.data.generatedAt || new Date().toISOString(),
          revisedAt: rewrite ? new Date().toISOString() : undefined,
          reflection: current?.data.reflection || "",
          followups: current?.data.followups || [],
          conversation: current?.data.conversation || [],
        };
        try {
          await backend.saveReport("report", id, value);
        } catch (error) {
          download(
            new Blob([JSON.stringify(value, null, 2)], {
              type: "application/json",
            }),
            "daily-private-unsaved-report.json",
          );
          throw Error(
            "The report was generated but could not be saved. A private recovery download was created. " +
              error.message,
          );
        }
        if (!isCurrent()) return;
        setDirty(false);
        document.querySelector("#dialog").close();
        show(replaceRow(id, value));
        notice(
          rewrite
            ? "Report regenerated. Your answers are preserved."
            : "Monthly report saved.",
        );
      } catch (err) {
        form.querySelector(".error").textContent = err.message;
      } finally {
        b.disabled = false;
      }
    };
  }
  async function followups() {
    if (draftDirty) throw Error("Save your answers first.");
    const current = selected,
      r = current.data,
      entries = selectedEntries(
        r.rangeStart || r.requestedStart || r.month + "-01",
        r.rangeEnd || r.requestedEnd || monthEnd(r.month),
      ),
      established = context();
    if (!entries.length)
      throw Error("No dated source entries for this report.");
    const result = await request(
      "followups",
      {
        provider: r.provider,
        model: r.model,
        report: r.report,
        entries,
        context: established,
      },
      `Send this report, ${entries.length} entries and ${established.included} earlier answers/reflections to ${r.provider} (${r.model})?`,
    );
    if (!result) return;
    const parsed = JSON.parse(
      result.text.replace(/^```(?:json)?\s*|\s*```$/g, ""),
    );
    const input = parsed.followups || parsed.questions;
    if (!Array.isArray(input))
      throw Error(
        "The response was not valid structured questions. Nothing was changed.",
      );
    const known = new Set([
      ...(r.followups || []).map((f) => f.q.trim().toLowerCase()),
      ...established.items
        .filter((x) => x.question)
        .map((x) => x.question.trim().toLowerCase()),
    ]);
    const fresh = input
      .filter(
        (f) =>
          typeof f.q === "string" &&
          f.q.trim() &&
          !known.has(f.q.trim().toLowerCase()),
      )
      .slice(0, 10)
      .map((f) => ({
        id: crypto.randomUUID(),
        q: f.q,
        theme: String(f.theme || ""),
        why: String(f.why || ""),
        a: "",
      }));
    const value = { ...r, followups: [...(r.followups || []), ...fresh] };
    await backend.saveReport("report", current.entity_id, value);
    if (isCurrent()) show(replaceRow(current.entity_id, value));
    notice(`${fresh.length} new questions saved.`);
  }
  function conversationDialog() {
    if (draftDirty) {
      notice("Save your reflection first.");
      return;
    }
    if (
      !selected.data.reflection?.trim() &&
      !selected.data.conversation?.length
    ) {
      notice("Write and save a reflection first.");
      return;
    }
    const current = selected,
      r = current.data;
    modal(
      "Open interrogation",
      `<form id="open-interrogation"><div class="fields">${modelFields(r.provider, r.model)}<label class="full">Your question<textarea name="question" aria-label="Your question" rows="4" required>What am I missing or avoiding in this reflection?</textarea></label><label class="full checkbox"><input type="checkbox" name="journal">Include journal entries for ${esc(r.month)}</label><label class="full checkbox"><input type="checkbox" name="context" checked>Include my earlier answers and reflections</label></div><p class="error"></p></form>`,
      `<button class="primary" form="open-interrogation">Ask</button>`,
    );
    const form = document.querySelector("#open-interrogation");
    form.onsubmit = async (e) => {
      e.preventDefault();
      const p = Object.fromEntries(new FormData(form));
      const entries = p.journal
          ? selectedEntries(r.month + "-01", monthEnd(r.month))
          : [],
        established = p.context
          ? context()
          : { items: [], included: 0, total: 0 };
      const b = document.querySelector("button[form=open-interrogation]");
      b.disabled = true;
      try {
        const result = await request(
          "reflect",
          {
            provider: p.provider,
            model: p.model,
            question: p.question,
            reflection: r.reflection,
            conversation: (r.conversation || []).slice(-16),
            context: established,
            entries,
          },
          `Send your reflection, this conversation, ${entries.length} journal entries and ${established.included} earlier answers/reflections to ${p.provider} (${p.model})?`,
        );
        if (!result) return;
        const value = {
          ...r,
          provider: p.provider,
          model: p.model,
          generatedAt: r.generatedAt || new Date().toISOString(),
          conversation: [
            ...(r.conversation || []),
            { role: "user", content: p.question },
            { role: "assistant", content: result.text },
          ],
        };
        await backend.saveReport("report", current.entity_id, value);
        if (!isCurrent()) return;
        setDirty(false);
        document.querySelector("#dialog").close();
        show(replaceRow(current.entity_id, value));
      } catch (err) {
        form.querySelector(".error").textContent = err.message;
      } finally {
        b.disabled = false;
      }
    };
  }
  function monthEnd(value) {
    const [y, m] = value.split("-").map(Number);
    return `${value}-${new Date(Date.UTC(y, m, 0)).getUTCDate()}`;
  }
  host.querySelector("#reflection-new").onclick = newReflection;
  host.querySelector("#monthly-new").onclick = () => generateDialog();
  host.querySelector("#advice-directive").onclick = () => {
    if (!discard()) return;
    modal(
      "Advice directive",
      `<textarea id="advice-text" aria-label="Advice directive" class="editor">${esc(advice())}</textarea>`,
      `<button id="advice-reset">Restore original stance</button><button id="advice-save" class="primary">Save directive</button>`,
    );
    document.querySelector("#advice-reset").onclick = () => {
      document.querySelector("#advice-text").value = DEFAULT_ADVICE;
    };
    document.querySelector("#advice-save").onclick = async () => {
      const prior = rows.find(
        (r) => r.entity_type === "prompt" && r.entity_id === "settings",
      );
      const value = {
        ...prior?.data,
        advice: document.querySelector("#advice-text").value,
        adviceUpdatedAt: new Date().toISOString(),
      };
      try {
        await backend.saveReport("prompt", "settings", value);
        if (prior) prior.data = value;
        else
          rows.push({
            entity_type: "prompt",
            entity_id: "settings",
            data: value,
          });
        setDirty(false);
        document.querySelector("#dialog").close();
        notice("Advice directive saved.");
      } catch (e) {
        notice(e.message);
      }
    };
  };
  if (available.length) show(available[0]);
  else newReflection();
  return { isDirty: () => draftDirty, dispose: () => {} };
}
