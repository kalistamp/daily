import { chromium, webkit } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
const folder = await mkdtemp(path.join(os.tmpdir(), "daily-test-"));
const screenshots = path.resolve("../private-migration/browser-verification");
await mkdir(screenshots, { recursive: true });
const fixture = {
  rows: {
    reports: [
      {
        entity_type: "report",
        entity_id: "synthetic-report",
        data: {
          id: "synthetic-report",
          month: "2026-09",
          provider: "openai",
          model: "synthetic-model",
          entryCount: 1,
          report: "A synthetic report.",
          reflection: "",
          followups: [{ id: "question", q: "What changed?", a: "" }],
        },
      },
      {
        entity_type: "prompt",
        entity_id: "settings",
        data: { advice: "An existing synthetic prompt." },
      },
    ],
    entries: [
      {
        id: "synthetic-entry",
        archive_year: 2026,
        entry_date: "2026-09-12",
        title: "A quiet Saturday",
        body_md:
          '## Notes\n\nA short walk, a finished chapter, and time to think.\n\n- Read a little\n- Make room for tomorrow\n\n```js\nconst day = "Saturday";\n```',
        source_key: "2026/synthetic.md",
        revision: 1,
      },
    ],
    documents: [
      {
        id: "synthetic-document",
        archive_year: 2026,
        title: "Reading notes",
        body_md: "A synthetic supporting document.",
        revision: 1,
      },
    ],
    years: [{ year: 2026, intro_md: "Small, steady steps.", revision: 1 }],
    assets: [],
  },
};
await writeFile(path.join(folder, "package.json"), JSON.stringify(fixture));
const child = spawn(process.execPath, ["tools/serve.mjs", "--review"], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: "4185", DAILY_REVIEW_DIR: folder },
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});
const launch = await new Promise((resolve, reject) => {
  let output = "";
  const timer = setTimeout(
    () => reject(Error("Server startup timeout")),
    15000,
  );
  child.stdout.on("data", (c) => {
    output += c;
    const m = output.match(
      /http:\/\/127\.0\.0\.1:\d+\/review\?token=[a-f0-9]+/,
    );
    if (m) {
      clearTimeout(timer);
      resolve(m[0]);
    }
  });
  child.on("error", reject);
});
const base = new URL(launch).origin;
let browser;
try {
  assert.equal((await fetch(base + "/__review/data")).status, 401);
  assert.equal(
    (await fetch(base + "/../private-migration/package.json")).status,
    404,
  );
  assert.equal((await fetch(base + "/src/app.js")).status, 404);
  const engine = process.env.DAILY_TEST_BROWSER === 'webkit' ? 'webkit' : 'chrome';
  browser = engine === 'webkit' ? await webkit.launch({headless:true}) : await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base);
  await page.getByRole("heading", { name: "Your private journal" }).waitFor();
  await page.screenshot({ path: path.join(screenshots, "signed-out.png") });
  await page.goto(launch);
  await page.getByRole('heading',{name:'Self-interrogation',exact:true}).waitFor();
  await page.getByLabel('Your reflection',{exact:true}).waitFor();
  await page.screenshot({path:path.join(screenshots,'reflection-desktop.png')});
  await page.getByRole('button',{name:'Journal',exact:true}).click();
  await page.getByRole("heading", { name: "2026 journal" }).waitFor();
  await page.screenshot({ path: path.join(screenshots, "desktop.png") });
  for (const y of [2022, 2023, 2024, 2025, 2026]) {
    await page.getByRole("button", { name: "New entry", exact: true }).click();
    await page.getByLabel("Year", { exact: true }).last().fill(String(y));
    await page.getByLabel("Date", { exact: true }).fill(`${y}-02-01`);
    await page.getByLabel("Title", { exact: true }).fill(`Synthetic ${y}`);
    await page
      .getByLabel("Entry", { exact: true })
      .fill(
        "Unicode café 雪\n\n<script>alert(1)</script>\n![tracking](https://example.invalid/pixel)",
      );
    await page.getByRole("button", { name: "Save entry", exact: true }).click();
    await page
      .getByRole("heading", { name: `${y} journal`, exact: true })
      .waitFor();
    await page
      .getByRole("heading", {
        name: `${y}-02-01 · Synthetic ${y}`,
        exact: true,
      })
      .waitFor();
  }
  const article = page.locator("article").filter({
    has: page.getByRole("heading", { name: "2026-02-01 · Synthetic 2026" }),
  });
  await article
    .getByRole("button", { name: "Edit entry", exact: true })
    .click();
  await page.getByLabel("Title", { exact: true }).fill("Edited synthetic");
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  assert.equal(await page.locator(".preview img,.preview script").count(), 0);
  await page.getByRole("button", { name: "Save entry", exact: true }).click();
  await page
    .getByRole("heading", { name: "2026-02-01 · Edited synthetic" })
    .waitFor();
  const edited = page.locator("article").filter({
    has: page.getByRole("heading", { name: "2026-02-01 · Edited synthetic" }),
  });
  await edited.getByRole("button", { name: "Revision history" }).click();
  await page.getByRole("button", { name: "View", exact: true }).click();
  await page.getByRole("button", { name: "Restore this revision" }).waitFor();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  page.on("dialog", (d) => d.accept());
  await edited.getByRole("button", { name: "Move entry to trash" }).click();
  await page.getByRole("button", { name: "Show trash", exact: true }).click();
  await page
    .getByRole("button", { name: "Restore entry", exact: true })
    .click();
  await page.getByRole("button", { name: "Show entries", exact: true }).click();
  await page.getByRole("button", { name: "Documents", exact: true }).click();
  await page.getByRole("button", { name: "Read", exact: true }).click();
  await page.getByText("A synthetic supporting document.").waitFor();
  await page.getByRole("button", { name: "Close", exact: true }).last().click();
  await page.getByRole("button", { name: "Reports", exact: true }).click();
  await page.getByLabel('Your reflection',{exact:true}).fill("A saved synthetic reflection.");
  await page
    .getByLabel("What changed?", { exact: true })
    .fill("A synthetic answer.");
  await page
    .getByRole("button", { name: "Save reflection", exact: true })
    .click();
  await page.getByText('Saved',{exact:true}).waitFor();
  await page.reload();
  assert.equal(
    await page.getByLabel('Your reflection',{exact:true}).inputValue(),
    "A saved synthetic reflection.",
  );
  assert.equal(
    await page.getByLabel("What changed?", { exact: true }).inputValue(),
    "A synthetic answer.",
  );
  await page.getByRole('button',{name:'Advice directive',exact:true}).click();
  assert.equal(await page.getByRole('textbox',{name:'Advice directive',exact:true}).inputValue(),'An existing synthetic prompt.');
  await page.getByRole('button',{name:'Close',exact:true}).click();
  await page.getByRole("button", { name: "Monthly report", exact: true }).click();
  assert.equal(await page.locator("select[name=provider] option").count(), 9);
  assert.equal(await page.locator('input[name=context]').isChecked(),true);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole('button',{name:'Open reflection',exact:true}).click();
  await page.getByLabel('Title',{exact:true}).fill('An open question');
  await page.getByLabel('Your reflection',{exact:true}).fill('I want to think about a choice, without making a monthly report.');
  await page.getByRole('button',{name:'Save reflection',exact:true}).click();
  await page.getByText('Saved',{exact:true}).waitFor();
  await page.reload();
  assert.equal(await page.getByLabel('Your reflection',{exact:true}).inputValue(),'I want to think about a choice, without making a monthly report.');
  await page.getByRole('button',{name:'Interrogate this',exact:true}).click();
  await page.getByRole('textbox',{name:'Your question',exact:true}).waitFor();
  assert.equal(await page.locator('input[name=journal]').isChecked(),false);
  await page.getByRole('button',{name:'Close',exact:true}).click();
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:path.join(screenshots,'reflection-mobile.png')});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.getByRole("button", { name: "Entries", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(screenshots, "mobile.png") });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.reload();
  await page.getByRole("heading", { name: "2026 journal" }).waitFor();
  assert.ok(page.url().includes("#/2026/entries"));
  for (const theme of ['light','dark']) {
    await page.evaluate(t=>{localStorage.setItem('daily-ui-theme',t);},theme);
    await page.reload();
    await page.getByRole('heading',{name:'2026 journal'}).waitFor();
    for (const [width,height] of [[320,740],[375,812],[390,844],[430,932],[768,1024],[1440,1000],[844,390]]) {
      await page.setViewportSize({width,height});
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${engine} ${theme} ${width}: overflow`);
      const notes=page.locator('summary[aria-label="Year Notes"]');
      assert.ok((await notes.boundingBox()).height>=44);
      if (width===390 || width===1440) await page.screenshot({path:path.join(screenshots,`${engine}-${theme}-${width}-journal.png`),fullPage:true});
      await page.getByRole('button',{name:'New entry',exact:true}).click();
      const input=page.getByLabel('Entry',{exact:true});
      assert.ok(await input.evaluate(el=>parseFloat(getComputedStyle(el).fontSize)>=16));
      await input.focus();
      const modal=await page.locator('dialog[open]').boundingBox();
      assert.ok(modal.x>=0 && modal.y>=0 && modal.x+modal.width<=width+1 && modal.y+modal.height<=height+1,`${engine} dialog bounds ${width}`);
      await page.getByRole('button',{name:'Close',exact:true}).click();
    }
    await page.setViewportSize({width:390,height:844});
    await page.locator('summary[aria-label="Year Notes"]').click();
    assert.equal(await page.locator('details.intro').getAttribute('open'),'');
    await page.reload();
    await page.getByRole('heading',{name:'2026 journal'}).waitFor();
    assert.equal(await page.locator('details.intro').getAttribute('open'),'');
    await page.locator('summary[aria-label="Year Notes"]').click();
    await page.getByRole('button',{name:'Self-interrogation',exact:true}).click();
    await page.getByLabel('Your reflection',{exact:true}).waitFor();
    for (const width of [320,390,768,1440]) {
      await page.setViewportSize({width,height:900});
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${engine} reflection ${width}: overflow`);
      if(width===390 || width===1440) await page.screenshot({path:path.join(screenshots,`${engine}-${theme}-${width}-reflection.png`),fullPage:true});
    }
    await page.getByRole('button',{name:'Journal',exact:true}).click();
  }
  const cookies = await page.context().cookies();
  const cookie = cookies.map((c) => `${c.name}=${c.value}`).join(";");
  assert.equal(
    (
      await fetch(base + "/__review/save", {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: "https://evil.invalid",
          "Content-Type": "application/json",
        },
        body: "{}",
      })
    ).status,
    403,
  );
  const rows = await (
    await fetch(base + "/__review/data", { headers: { Cookie: cookie } })
  ).json();
  const r = rows.entries.find((r) => r.title === "Edited synthetic");
  const update = {
    kind: "entries",
    row: { id: r.id, title: "Updated again" },
    expected: r.revision,
  };
  assert.equal(
    (
      await fetch(base + "/__review/save", {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: base,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(update),
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await fetch(base + "/__review/save", {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: base,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(update),
      })
    ).status,
    400,
  );
  assert.deepEqual(errors, []);
  // Actual private package is only read; screenshots remain outside git.
  const log = await readFile("../private-migration/preview.log", "utf8");
  const actual = log.match(
    /http:\/\/127\.0\.0\.1:\d+\/review\?token=[a-f0-9]+/,
  )?.[0];
  if (actual) {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(actual);
    await page.getByRole('heading',{name:'Self-interrogation',exact:true}).waitFor();
    await page.getByLabel('Your reflection',{exact:true}).waitFor();
    await page.screenshot({path:path.join(screenshots,'private-reflection-desktop.png')});
    await page.getByRole('button',{name:'Journal',exact:true}).click();
    await page.getByRole("heading", { name: "2026 journal" }).waitFor();
    await page.screenshot({
      path: path.join(screenshots, "private-desktop.png"),
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: path.join(screenshots, "private-mobile.png"),
    });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
  }
  console.log(
    "PASS: signed-out shell, every-year create, edit, Unicode, safe preview, history, trash/restore, documents, hash reload, stale conflicts, local access controls, desktop/mobile layout.",
  );
} finally {
  await browser?.close();
  child.kill();
  await new Promise((resolve) =>
    child.exitCode !== null ? resolve() : child.once("exit", resolve),
  );
}
