import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { mountInterrogation } from "../src/interrogation.js";

test("reflection drafts survive opening tools and failed AI saves retain a recovery copy", async () => {
  const dom = new JSDOM('<main></main><dialog id="dialog"></dialog>');
  const priorDocument = globalThis.document, priorConfirm = globalThis.confirm, priorFormData = globalThis.FormData;
  globalThis.document = dom.window.document;
  globalThis.confirm = () => true;
  globalThis.FormData = dom.window.FormData;
  const host = document.querySelector("main"), dialog = document.querySelector("dialog");
  dialog.close = () => {};
  const notices = [], copies = [];
  let dirty = false, finishRequest, saveFails = false, saves = 0, latest;
  const backend = {
    async saveReport(type, id, value) { saves++; if(saveFails) throw Error("Conflict"); latest = value; },
    edge: () => new Promise(resolve => {finishRequest = resolve;}),
  };
  const escape = s => String(s ?? "").replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
  try {
    mountInterrogation({host, backend, rows: [{entity_type: "report", entity_id: "r", data: {id: "r", kind: "reflection", title: "Original", month: "2026-09", reflection: "Saved reflection", generatedAt: "2026-09-01", followups: []}}],
      journal: {entries: []}, year: 2026, esc: escape, icon: () => "", markdown: (el, value) => {el.textContent = value;},
      notice: value => notices.push(value), download: blob => copies.push(blob), setDirty: value => {dirty = value;}, isCurrent: () => true,
      modal: (title, body, footer) => {dialog.innerHTML = body + footer;},
    });
    const notes = host.querySelector("#reflection-notes");
    notes.value = "Unsaved reflection";
    notes.oninput();
    host.querySelector("#advice-directive").click();
    assert.equal(dirty, true);
    assert.equal(dialog.querySelector("#advice-text"), null);
    assert.equal(notes.value, "Unsaved reflection");
    host.querySelector("#reflection-title").value = "";
    await host.querySelector("#reflection-save").onclick();
    assert.equal(latest.title, "");
    assert.equal(dirty, false);
    host.querySelector("#reflection-ask").click();
    const form = dialog.querySelector("form");
    form.elements.model.value = "synthetic";
    saveFails = true;
    const running = form.onsubmit({preventDefault() {}});
    host.querySelector("#reflection-new").click();
    assert.match(notices.at(-1), /Wait/);
    finishRequest({text: "A generated synthetic response"});
    await running;
    assert.equal(saves, 2);
    assert.equal(copies.length, 1);
    assert.match(await copies[0].text(), /generated synthetic response/);
    assert.match(form.querySelector(".error").textContent, /recovery download/);
  } finally {
    dom.window.close(); globalThis.document = priorDocument; globalThis.confirm = priorConfirm; globalThis.FormData = priorFormData;
  }
});
