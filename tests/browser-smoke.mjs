// Actual, isolated Chromium QA of the PUBLIC fictional-data demo.
// CI-only: no credentials, private Factory files, network calls or real customers.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const STORAGE = 'feastlab-private-v1';
const htmlPath = resolve('index.html');
const html = await readFile(htmlPath);
const server = createServer((req, res) => {
  if (req.url !== '/' && req.url !== '/index.html') {
    res.writeHead(404); res.end('Not found'); return;
  }
  res.writeHead(200, {'content-type':'text/html; charset=utf-8', 'cache-control':'no-store'});
  res.end(html);
});
const temp = await mkdtemp(join(tmpdir(), 'feast-lab-browser-'));
let browser;
try {
  await new Promise((resolveReady, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveReady);
  });
  const origin = 'http://127.0.0.1:' + server.address().port + '/';
  const executablePath = process.env.CHROME_BIN ||
    ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium']
      .find(existsSync);
  assert.ok(executablePath, 'Chrome/Chromium executable required for real-browser QA');
  browser = await chromium.launch({executablePath, headless:true,
    args:['--no-sandbox', '--disable-dev-shm-usage']});
  const context = await browser.newContext({acceptDownloads:true});
  const page = await context.newPage();
  await page.goto(origin);
  await page.locator('#sampleEvent').click();
  assert.equal(await page.locator('#eventName').inputValue(), 'Fictional Community Dinner');
  assert.equal(await page.evaluate(key => localStorage.getItem(key), STORAGE), null,
    'Loading a sample must not write persistent storage');
  console.log('PASS: sample does not persist automatically');

  await page.locator('#next').click();
  await page.locator('#next').click();
  await page.locator('#save').click();
  const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), STORAGE);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].data.eventName, 'Fictional Community Dinner');
  console.log('PASS: explicit save writes exactly one fictional event');

  await page.reload();
  const reloaded = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), STORAGE);
  assert.deepEqual(reloaded, saved);
  console.log('PASS: saved data survives real browser reload');

  await page.locator('#backupTools summary').click();
  const downloadPromise = page.waitForEvent('download', {timeout:10000});
  await page.locator('#export').click();
  const download = await downloadPromise;
  const backup = JSON.parse(await readFile(await download.path(), 'utf8'));
  assert.equal(backup.format, 'feastlab-backup-v1');
  assert.equal(backup.events.length, 1);
  assert.equal(backup.events[0].key, saved[0].key);
  console.log('PASS: actual browser download contains the fictional backup');

  const imported = {...saved[0], key:'fictional-browser-import-1',
    updatedAt:new Date().toISOString(),
    data:{...saved[0].data, eventName:'Fictional Test Reception'}};
  await page.locator('#importFile').setInputFiles({
    name:'fictional-backup.json', mimeType:'application/json',
    buffer:Buffer.from(JSON.stringify({format:'feastlab-backup-v1',events:[imported]}))
  });
  await page.waitForFunction(key => {
    const records = JSON.parse(localStorage.getItem(key) || '[]');
    return records.length === 2;
  }, STORAGE, {timeout:10000});
  const merged = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), STORAGE);
  assert.equal(merged.find(x => x.key === saved[0].key).data.eventName,
    'Fictional Community Dinner');
  assert.equal(merged.find(x => x.key === imported.key).data.eventName,
    'Fictional Test Reception');
  console.log('PASS: real file-input import preserves existing identity and adds fictional event');

  const secondTab = await context.newPage();
  await secondTab.goto(origin);
  await secondTab.locator('#eventName').fill('Unsaved work in another tab');
  await page.locator('#sampleEvent').click();
  await page.locator('#next').click();
  await page.locator('#next').click();
  await page.locator('#save').click();
  await secondTab.waitForFunction(() =>
    document.querySelector('#status').textContent.includes('another tab'), null,
    {timeout:10000});
  assert.equal(await secondTab.locator('#eventName').inputValue(),
    'Unsaved work in another tab');
  assert.equal((await secondTab.evaluate(key => JSON.parse(localStorage.getItem(key)), STORAGE)).length, 3);
  console.log('PASS: cross-tab storage notification does not erase unsaved form edits');
  console.log('RESULT: 6/6 actual Chromium flows passed, fictional data only');
} finally {
  if (browser) await browser.close();
  await new Promise(resolveClose => server.close(resolveClose));
  await rm(temp, {recursive:true, force:true});
}
