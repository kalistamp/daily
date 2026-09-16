import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';

// Synthetic data only. No authenticated backend or private review files are used.
const year = new Date().getFullYear();
const fixture = { entries: Array.from({length: 36}, (_,i) => ({id:`entry-${i}`,archive_year:year,entry_date:`${year}-${i < 18 ? '09' : '08'}-${String(28-i%18).padStart(2,'0')}`,title:i===0?'A quiet Saturday':`Notebook page ${i}`,body_md:'## Making room\n\nA short walk, a finished chapter, and time to think.\n\n- Read a little\n- Make room for tomorrow',revision:1})),years:[{year,intro_md:'Small, steady steps.',revision:1},{year:year-1,intro_md:''}],documents:[],assets:[] };
const reports=[{entity_type:'report',entity_id:'report-1',data:{id:'report-1',kind:'reflection',month:`${year}-09`,title:'September reflections',reflection:'What deserves more attention?',generatedAt:'2026-09-01',followups:[]}}];
const server=http.createServer(async(req,res)=>{
  const file={'/':'index.html','/style.css':'style.css','/assets/app.js':'assets/app.js'}[req.url?.split('?')[0]];
  if(!file){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(await readFile(file));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try {
  browser=await chromium.launch({channel:'chrome',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  const errors=[];page.on('pageerror',e=>{errors.push(e.message); console.error(e.message);});
  let failSave=false;
  await page.route('**/__review/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    let body={};let status=200;
    if(path.endsWith('/data')) body=fixture;
    else if(path.endsWith('/reports')) body=reports;
    else if(path.endsWith('/save')) {
      if(failSave){status=409;body={error:'Synthetic revision conflict. Try again.'};}
      else {const {row}=route.request().postDataJSON();const index=fixture.entries.findIndex(e=>e.id===row.id);if(index>=0)fixture.entries[index]={...fixture.entries[index],...row,revision:2};else fixture.entries.unshift({...row,revision:1});}
    }
    else if(path.endsWith('/history')) body=[];
    await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.locator('.entry-choice').first().waitFor();
  assert.equal(await page.locator('.entry-choice').count(),30);
  await page.getByRole('button',{name:'Load more entries'}).click();
  await expect(page.locator('.entry-choice')).toHaveCount(36);
  await page.getByRole('searchbox').fill('Notebook page 20');
  await expect(page.locator('.entry-choice')).toHaveCount(1);
  assert.equal(await page.locator('#year').count(),1);
  await page.getByRole('searchbox').fill('no-match-xyz');
  await page.getByText('No matching entries.').waitFor();
  await page.getByRole('searchbox').fill('');
  await page.locator('.entry-choice').first().click();
  await page.getByRole('button',{name:'Edit entry',exact:true}).click();
  await page.locator('#editor [name=body_md]').fill('A revised synthetic entry.');
  await page.getByText('Unsaved changes',{exact:true}).waitFor();
  page.once('dialog',d=>d.dismiss());
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#dialog').evaluate(el=>el.open),true);
  failSave=true;await page.getByRole('button',{name:'Save entry',exact:true}).click();
  await page.getByText('Synthetic revision conflict. Try again.').waitFor();
  assert.equal(await page.locator('#editor [name=body_md]').inputValue(),'A revised synthetic entry.');
  await page.getByRole('button',{name:'Preview',exact:true}).click();
  await expect(page.locator('#editor .preview')).toHaveText('A revised synthetic entry.');
  await expect(page.locator('#editor [name=body_md]')).toBeHidden();
  await page.getByRole('button',{name:'Continue writing',exact:true}).click();
  await expect(page.locator('#editor [name=body_md]')).toBeVisible();
  failSave=false;await page.getByRole('button',{name:'Save entry',exact:true}).click();
  await page.locator('.studio-reading .markdown').getByText('A revised synthetic entry.').waitFor();
  await mkdir('node_modules/.studio-review',{recursive:true});
  for(const width of [1440,1024,768,390,320]) {
    await page.setViewportSize({width,height:1000});
    await page.locator('.sidebar [data-view=entries]').click();
    if(width<=760){assert.equal(await page.locator('.studio-detail').isVisible(),false);await page.locator('.entry-choice').first().click();assert.equal(await page.locator('.studio-library').isVisible(),false);await page.getByRole('button',{name:'← All entries'}).click();}
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`Overflow at ${width}`);
    await page.screenshot({animations:'disabled',path:`node_modules/.studio-review/journal-${width}.png`,fullPage:false});
  }
  await page.setViewportSize({width:1440,height:1000});
  await page.locator('#theme').click();
  await page.screenshot({path:'node_modules/.studio-review/journal-light.png',fullPage:true});
  await page.getByRole('button',{name:'New entry',exact:true}).click();
  await page.screenshot({path:'node_modules/.studio-review/editor.png',fullPage:true});
  await page.keyboard.press('Escape');
  await page.locator('#year').selectOption(String(year-1));
  await page.getByText('Your notebook starts here.').waitFor();
  await page.locator('#year').selectOption(String(year));
  await expect(page.locator('.entry-choice')).toHaveCount(30);
  await page.locator('#trash').click();
  await page.getByText('Trash is empty.').waitFor();
  await page.locator('#trash').click();
  await page.locator('.sidebar [data-view=reports]').click();
  await page.locator('#reflection-notes').waitFor();
  await page.screenshot({path:'node_modules/.studio-review/reflections.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Reflection mobile overflow');
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await page.locator('.sidebar button').first().evaluate(el=>getComputedStyle(el).animationDuration),'1e-05s');
  assert.deepEqual(errors,[]);
  console.log('Studio browser checks passed: selection, search, pagination, save recovery, unsaved guard, mobile navigation, themes, reflections, reduced motion, no page errors.');
} finally {await browser?.close();server.close();}


