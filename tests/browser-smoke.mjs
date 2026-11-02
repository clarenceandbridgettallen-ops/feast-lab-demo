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

  // Exercise the real file input on a malformed backup. A rejected import must
  // never replace existing fictional records or strand the import button.
  const beforeRejected = await page.evaluate(key => localStorage.getItem(key), STORAGE);
  const malformed = {...imported, key:'fictional-invalid-timestamp',
    updatedAt:['not-a-timestamp']};
  await page.locator('#importFile').setInputFiles({
    name:'fictional-invalid-backup.json', mimeType:'application/json',
    buffer:Buffer.from(JSON.stringify({format:'feastlab-backup-v1',events:[malformed]}))
  });
  await page.waitForFunction(() =>
    document.querySelector('#errorBox').textContent.includes('Import failed:'),
    null, {timeout:10000});
  await page.waitForFunction(() => !document.querySelector('#importBackup').disabled,
    null, {timeout:10000});
  assert.equal(await page.evaluate(key => localStorage.getItem(key), STORAGE),
    beforeRejected, 'Rejected import must leave saved records byte-for-byte unchanged');
  console.log('PASS: malformed backup timestamp rejected without modifying saved events');

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
  // Separate mobile/touch context. Still local fictional-data HTML, not a live-site or Android claim.
  const mobileContext = await browser.newContext({
    viewport:{width:390,height:844}, isMobile:true, hasTouch:true
  });
  try {
    const mobile = await mobileContext.newPage();
    await mobile.goto(origin);
    const mobileMetrics = await mobile.evaluate(() => ({
      viewport: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth
    }));
    assert.ok(mobileMetrics.scrollWidth <= mobileMetrics.viewport + 1,
      'Mobile demo must not require horizontal page scrolling: ' + JSON.stringify(mobileMetrics));
    for (const id of ['sampleEvent','next']) {
      const size = await mobile.locator('#' + id).evaluate(el => {
        const box = el.getBoundingClientRect();
        return {width:box.width,height:box.height};
      });
      assert.ok(size.width >= 44 && size.height >= 44,
        id + ' touch target must be at least 44x44: ' + JSON.stringify(size));
    }
    console.log('PASS: 390px emulated touch viewport has no horizontal overflow and primary targets meet 44px');

    await mobile.locator('#sampleEvent').click();
    await mobile.locator('#next').click();
    await mobile.locator('#next').click();
    await mobile.emulateMedia({media:'print'});
    assert.equal(await mobile.locator('header').isVisible(), false);
    assert.equal(await mobile.locator('nav').isVisible(), false);
    assert.equal(await mobile.locator('#screen2').isVisible(), true);
    assert.equal(await mobile.locator('#quote').isVisible(), true);
    console.log('PASS: print CSS hides app controls and retains the fictional quote');
  } finally {
    await mobileContext.close();
  }
  console.log('RESULT: 9/9 actual Chromium flows passed, fictional data only');
} finally {
  if (browser) await browser.close();
  await new Promise(resolveClose => server.close(resolveClose));
  await rm(temp, {recursive:true, force:true});
}
