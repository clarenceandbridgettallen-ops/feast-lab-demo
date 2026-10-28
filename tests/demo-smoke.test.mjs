import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
const source = scripts.join('\n');

function mockElement(id = '') {
  const listeners = new Map();
  const classes = new Set();
  return {
    id, value: '', textContent: '', disabled: false, listeners, children: [],
    classList: {
      add: name => classes.add(name), remove: name => classes.delete(name),
      toggle: (name, force) => { if (force === undefined ? !classes.has(name) : force) classes.add(name); else classes.delete(name); },
      contains: name => classes.has(name),
    },
    setAttribute() {}, removeAttribute() {}, focus() {}, remove() {},
    addEventListener: (name, fn) => listeners.set(name, fn),
    append(...nodes) { this.children.push(...nodes); },
    appendChild(node) { this.children.push(node); },
    replaceChildren(...nodes) { this.children = nodes; },
    click() { return listeners.get('click')?.(); },
  };
}

function createApp(sharedStorage = null, urlApi = URL) {
  const ids = ['eventName','eventDate','guests','margin','tax','discount','serviceFee','deposit','food','labor','overhead','other'];
  const defaults = {guests:'40',margin:'30',tax:'0',discount:'0',serviceFee:'0',deposit:'30',food:'240',labor:'150',overhead:'60',other:'39'};
  const elements = new Map();
  const get = id => { if (!elements.has(id)) elements.set(id, mockElement(id)); return elements.get(id); };
  for (const id of ids) get(id).value = defaults[id] ?? '';
  const stored = sharedStorage ?? new Map();
  let writes = 0;
  const localStorage = {
    getItem: key => stored.has(key) ? stored.get(key) : null,
    setItem: (key, value) => { writes++; stored.set(key, String(value)); },
  };
  const windowEvents = new Map();
  const window = {
    confirm: () => true, scrollTo() {}, print() {},
    addEventListener: (name, fn) => windowEvents.set(name, fn),
  };
  const document = {
    body: mockElement('body'),
    getElementById: get,
    querySelector: selector => ({textContent: selector.replace(/.*for="([^"]+)".*/, '$1')}),
    createElement: () => mockElement(),
    addEventListener() {},
  };
  vm.runInNewContext(source, {document, window, localStorage, Blob, URL: urlApi, Intl, console, setTimeout, clearTimeout}, {timeout: 2000});
  return {get, stored, localStorage, window, windowEvents, writes: () => writes};
}

test('inline application JavaScript parses and has local-only network policy', () => {
  assert.ok(scripts.length > 0, 'Expected inline JavaScript');
  assert.doesNotThrow(() => new vm.Script(source));
  assert.match(html, /connect-src\s+'none'/);
  assert.match(html, /form-action\s+'none'/);
});

test('fictional sample loads without writing saved events and can advance', () => {
  const app = createApp();
  app.get('sampleEvent').click();
  assert.equal(app.get('eventName').value, 'Fictional Community Dinner');
  assert.equal(app.writes(), 0, 'Loading a sample must not save customer data');
  app.get('next').click();
  assert.equal(app.get('screen1').classList.contains('hidden'), false);
});

test('explicit save persists one local event and storage refresh preserves edits', () => {
  const app = createApp();
  app.get('sampleEvent').click();
  app.get('save').click();
  const key = 'feastlab-private-v1';
  const events = JSON.parse(app.stored.get(key));
  assert.equal(events.length, 1);
  assert.equal(events[0].data.eventName, 'Fictional Community Dinner');
  app.get('eventName').value = 'Unsaved editing in this tab';
  app.windowEvents.get('storage')({storageArea: app.localStorage, key});
  assert.equal(app.get('eventName').value, 'Unsaved editing in this tab');
  assert.equal(JSON.parse(app.stored.get(key)).length, 1);
});


test('valid backup adds new events but never overwrites matching saved identities', async () => {
  const app = createApp();
  app.get('sampleEvent').click();
  app.get('save').click();
  const key = 'feastlab-private-v1';
  const original = JSON.parse(app.stored.get(key))[0];
  const incoming = {
    format: 'feastlab-backup-v1',
    events: [
      {...original, data: {...original.data, eventName: 'Must not replace saved event'}},
      {key: 'imported-fictional-event', updatedAt: new Date().toISOString(),
        data: {...original.data, eventName: 'Another fictional event'}},
    ],
  };
  const input = app.get('importFile');
  await input.listeners.get('change')({target: {
    files: [{size: 1000, text: async () => JSON.stringify(incoming)}], value: 'selected.json',
  }});
  const events = JSON.parse(app.stored.get(key));
  assert.equal(events.length, 2);
  assert.equal(events.find(x => x.key === original.key).data.eventName, original.data.eventName);
  assert.equal(events.find(x => x.key === 'imported-fictional-event').data.eventName, 'Another fictional event');
  assert.match(app.get('status').textContent, /1 new event\(s\); 1 matching event\(s\) preserved/);
});

test('invalid backup cannot alter an existing saved event', async () => {
  const app = createApp();
  app.get('sampleEvent').click();
  app.get('save').click();
  const key = 'feastlab-private-v1';
  const before = app.stored.get(key);
  const writes = app.writes();
  const invalid = {format: 'feastlab-backup-v1', events: [
    {key: 'invalid-guest-count', data: {...JSON.parse(before)[0].data, guests: '0'}},
  ]};
  await app.get('importFile').listeners.get('change')({target: {
    files: [{size: 1000, text: async () => JSON.stringify(invalid)}], value: 'selected.json',
  }});
  assert.equal(app.stored.get(key), before);
  assert.equal(app.writes(), writes);
  assert.match(app.get('errorBox').textContent, /Import failed: Backup format or event data is invalid/);
});

test('import refuses to overwrite unreadable local storage', async () => {
  const app = createApp();
  const key = 'feastlab-private-v1';
  const damaged = '{unreadable original event bytes';
  app.stored.set(key, damaged);
  const writes = app.writes();
  await app.get('importFile').listeners.get('change')({target: {
    files: [{size: 100, text: async () => JSON.stringify({format: 'feastlab-backup-v1', events: []})}],
    value: 'selected.json',
  }});
  assert.equal(app.stored.get(key), damaged);
  assert.equal(app.writes(), writes);
  assert.match(app.get('errorBox').textContent, /Import failed: Existing saved events are unreadable/);
});
test('import above the 100-event limit preserves every existing event', async () => {
  const app = createApp();
  app.get('sampleEvent').click();
  app.get('save').click();
  const key = 'feastlab-private-v1';
  const template = JSON.parse(app.stored.get(key))[0];
  const full = Array.from({length: 100}, (_, i) => ({
    ...template, key: 'synthetic-existing-' + i,
    data: {...template.data, eventName: 'Fictional event ' + i},
  }));
  const original = JSON.stringify(full);
  app.stored.set(key, original);
  const writes = app.writes();
  const incoming = {format: 'feastlab-backup-v1', events: [{
    ...template, key: 'synthetic-over-capacity',
    data: {...template.data, eventName: 'Additional fictional event'},
  }]};
  await app.get('importFile').listeners.get('change')({target: {
    files: [{size: 1000, text: async () => JSON.stringify(incoming)}],
    value: 'selected.json',
  }});
  assert.equal(app.stored.get(key), original, 'Capacity error must preserve original bytes');
  assert.equal(app.writes(), writes, 'Capacity error must not write storage');
  assert.match(app.get('errorBox').textContent, /Import failed: Import exceeds the 100-event storage limit/);
});

test('malformed JSON backup never changes an existing saved event', async () => {
  const app = createApp();
  app.get('sampleEvent').click();
  app.get('save').click();
  const key = 'feastlab-private-v1';
  const original = app.stored.get(key);
  const writes = app.writes();
  await app.get('importFile').listeners.get('change')({target: {
    files: [{size: 40, text: async () => '{not valid JSON'}],
    value: 'selected.json',
  }});
  assert.equal(app.stored.get(key), original);
  assert.equal(app.writes(), writes);
  assert.match(app.get('errorBox').textContent, /Import failed:/);
});


test('deleting one saved event preserves the other event and refreshes the list', () => {
  const app = createApp();
  app.get('sampleEvent').click();
  app.get('save').click();
  app.get('newEvent').click();
  app.get('eventName').value = 'Fictional Birthday';
  app.get('save').click();
  const key = 'feastlab-private-v1';
  const before = JSON.parse(app.stored.get(key));
  assert.equal(before.length, 2);
  app.get('savedList').children[0].children[2].click();
  const after = JSON.parse(app.stored.get(key));
  assert.equal(after.length, 1);
  assert.equal(after[0].key, before[1].key, 'The other event identity must remain unchanged');
  assert.equal(after[0].data.eventName, 'Fictional Community Dinner');
  assert.equal(app.get('savedList').children.length, 1);
  assert.match(app.get('status').textContent, /Other events were preserved/);
});

test('stale tab cannot overwrite a newer saved-event edit', () => {
  const shared = new Map();
  const first = createApp(shared);
  first.get('sampleEvent').click();
  first.get('save').click();
  const second = createApp(shared);
  second.get('savedList').children[0].children[1].click();
  first.get('eventName').value = 'First tab newest version';
  first.get('save').click();
  const before = shared.get('feastlab-private-v1');
  second.get('eventName').value = 'Second tab stale version';
  second.get('save').click();
  assert.equal(shared.get('feastlab-private-v1'), before, 'Stale save must not change saved bytes');
  assert.equal(second.get('eventName').value, 'Second tab stale version', 'Unsaved edits remain visible');
  assert.match(second.get('errorBox').textContent, /changed in another tab/);
});

test('stale tab cannot revive an event deleted in another tab', () => {
  const shared = new Map();
  const first = createApp(shared);
  first.get('sampleEvent').click();
  first.get('save').click();
  const second = createApp(shared);
  second.get('savedList').children[0].children[1].click();
  first.get('savedList').children[0].children[2].click();
  const before = shared.get('feastlab-private-v1');
  second.get('eventName').value = 'Unsaved after deletion';
  second.get('save').click();
  assert.equal(shared.get('feastlab-private-v1'), before, 'Deleted event must not be recreated');
  assert.equal(second.get('eventName').value, 'Unsaved after deletion');
  assert.match(second.get('errorBox').textContent, /deleted in another tab/);
});

test('deletion confirmation cannot erase a concurrent tab save', () => {
  const shared = new Map();
  const app = createApp(shared);
  app.get('sampleEvent').click();
  app.get('save').click();
  const key = 'feastlab-private-v1';
  const original = JSON.parse(shared.get(key));
  const newEntry = {...original[0], key: 'other-tab-new-event',
    data: {...original[0].data, eventName: 'Another fictional booking'}};
  const writes = app.writes();
  app.window.confirm = () => {
    shared.set(key, JSON.stringify([newEntry, ...original]));
    return true;
  };
  app.get('savedList').children[0].children[2].click();
  const after = JSON.parse(shared.get(key));
  assert.equal(after.length, 2, 'Both existing and concurrent events must survive');
  assert.equal(after[0].key, newEntry.key);
  assert.equal(after[1].key, original[0].key);
  assert.equal(app.writes(), writes, 'The stale confirmation must not write storage');
  assert.match(app.get('errorBox').textContent, /changed in another tab while confirming deletion/);
});


test('canceling a new-event or sample switch preserves unsaved catering edits', () => {
  const app = createApp();
  app.get('sampleEvent').click();
  app.get('eventName').value = 'Fictional unsaved event edits';
  const beforeWrites = app.writes();
  let confirmations = 0;
  app.window.confirm = () => { confirmations++; return false; };
  app.get('newEvent').click();
  assert.equal(app.get('eventName').value, 'Fictional unsaved event edits');
  app.get('sampleEvent').click();
  assert.equal(app.get('eventName').value, 'Fictional unsaved event edits');
  assert.equal(confirmations, 2, 'Both destructive navigation paths must ask permission');
  assert.equal(app.writes(), beforeWrites, 'Canceling must not touch saved-event storage');
});

test('empty or duplicate-only backup imports do not rewrite existing local storage', async () => {
  const app = createApp();
  app.get('sampleEvent').click();
  app.get('save').click();
  const key = 'feastlab-private-v1';
  const original = app.stored.get(key);
  const existing = JSON.parse(original)[0];
  for (const events of [[], [{...existing, data: {...existing.data, eventName: 'Conflicting duplicate'}}]]) {
    const beforeWrites = app.writes();
    await app.get('importFile').listeners.get('change')({target: {
      files: [{size: 1000, text: async () => JSON.stringify({format: 'feastlab-backup-v1', events})}],
      value: 'backup.json',
    }});
    assert.equal(app.stored.get(key), original, 'No-op import must preserve original storage bytes');
    assert.equal(app.writes(), beforeWrites, 'No-op import must not write browser storage');
    assert.match(app.get('status').textContent, /no new events to add/);
  }
});

test('storage quota failure preserves prior event and recoverable unsaved edits', () => {
  const app = createApp();
  app.get('sampleEvent').click();
  app.get('save').click();
  const key = 'feastlab-private-v1';
  const original = app.stored.get(key);
  const originalId = JSON.parse(original)[0].key;
  const revisedName = 'Fictional update waiting for storage';
  app.get('eventName').value = revisedName;
  const originalSetItem = app.localStorage.setItem;
  app.localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
  app.get('save').click();
  assert.equal(app.stored.get(key), original, 'Failed save must not change stored bytes');
  assert.match(app.get('errorBox').textContent, /Device storage is unavailable or full/);
  const beforeUnload = {preventDefault() { this.prevented = true; }, returnValue: undefined};
  app.windowEvents.get('beforeunload')(beforeUnload);
  assert.equal(beforeUnload.prevented, true, 'Unsaved edits must still warn on exit');
  assert.equal(beforeUnload.returnValue, '');
  app.localStorage.setItem = originalSetItem;
  app.get('save').click();
  const updated = JSON.parse(app.stored.get(key));
  assert.equal(updated.length, 1);
  assert.equal(updated[0].key, originalId, 'Retry must preserve the saved identity');
  assert.equal(updated[0].data.eventName, revisedName);
});


test('backup import storage failure preserves existing records and allows a clean retry', async () => {
  const app = createApp();
  app.get('sampleEvent').click();
  app.get('save').click();
  const key = 'feastlab-private-v1';
  const before = app.stored.get(key);
  const saved = JSON.parse(before)[0];
  const incoming = {format: 'feastlab-backup-v1', events: [{
    ...saved, key: 'fictional-retry-import',
    data: {...saved.data, eventName: 'Fictional retry booking'},
  }]};
  const file = {size: 1000, text: async () => JSON.stringify(incoming)};
  const importFile = app.get('importFile');
  app.get('eventName').value = 'Unsaved draft survives import failure';
  const originalSetItem = app.localStorage.setItem;
  app.localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
  await importFile.listeners.get('change')({target: {files: [file], value: 'backup.json'}});
  assert.equal(app.stored.get(key), before, 'Quota failure must preserve original saved bytes');
  assert.equal(app.get('eventName').value, 'Unsaved draft survives import failure');
  assert.match(app.get('errorBox').textContent, /Device storage is unavailable or full/);
  app.localStorage.setItem = originalSetItem;
  await importFile.listeners.get('change')({target: {files: [file], value: 'backup.json'}});
  const after = JSON.parse(app.stored.get(key));
  assert.equal(after.length, 2, 'Retry must add exactly one new event');
  assert.equal(after.find(x => x.key === saved.key).data.eventName, saved.data.eventName);
  assert.equal(after.find(x => x.key === 'fictional-retry-import').data.eventName, 'Fictional retry booking');
  assert.equal(app.get('eventName').value, 'Unsaved draft survives import failure');
});


test('damaged local storage can be downloaded byte-for-byte without modifying saved records', async () => {
  const downloads = [];
  const app = createApp(null, {
    createObjectURL(blob) { downloads.push(blob); return 'blob:fictional-recovery'; },
    revokeObjectURL() {},
  });
  const key = 'feastlab-private-v1';
  const damaged = '{"unfinished event": [do not overwrite these bytes';
  app.stored.set(key, damaged);
  const beforeWrites = app.writes();
  app.get('recover').click();
  assert.equal(downloads.length, 1, 'Recovery must create exactly one private download');
  assert.equal(await downloads[0].text(), damaged, 'Recovery must preserve raw bytes, not parse or rewrite them');
  assert.equal(app.stored.get(key), damaged, 'Existing damaged storage must remain untouched');
  assert.equal(app.writes(), beforeWrites, 'Recovery must not write to local storage');
  assert.match(app.get('status').textContent, /Raw storage downloaded/);
});

test('recovery download refuses to duplicate healthy saved-event storage', () => {
  const downloads = [];
  const app = createApp(null, {
    createObjectURL(blob) { downloads.push(blob); return 'blob:should-not-be-created'; },
    revokeObjectURL() {},
  });
  app.get('sampleEvent').click();
  app.get('save').click();
  const key = 'feastlab-private-v1';
  const original = app.stored.get(key);
  const beforeWrites = app.writes();
  app.get('recover').click();
  assert.equal(downloads.length, 0, 'Healthy records should use structured Export backup instead');
  assert.equal(app.stored.get(key), original);
  assert.equal(app.writes(), beforeWrites);
  assert.match(app.get('status').textContent, /Saved events are readable/);
});


test('overlapping asynchronous backup imports cannot lose previously imported events', async () => {
  const app = createApp();
  app.get('sampleEvent').click();
  app.get('save').click();
  const key = 'feastlab-private-v1';
  const saved = JSON.parse(app.stored.get(key))[0];
  const makeBackup = (id, name) => JSON.stringify({
    format: 'feastlab-backup-v1',
    events: [{...saved, key: id, data: {...saved.data, eventName: name}}],
  });
  let releaseFirst;
  const firstFile = {size: 1000, text: () => new Promise(resolve => { releaseFirst = resolve; })};
  let secondReads = 0;
  const secondFile = {size: 1000, text: async () => {
    secondReads++;
    return makeBackup('fictional-second', 'Fictional second');
  }};
  const onChange = app.get('importFile').listeners.get('change');
  const first = onChange({target: {files: [firstFile], value: 'first.json'}});
  assert.equal(app.get('importBackup').disabled, true, 'Import button disabled while reading');
  await onChange({target: {files: [secondFile], value: 'second.json'}});
  assert.equal(secondReads, 0, 'Overlapping file must not be read or imported');
  assert.equal(JSON.parse(app.stored.get(key)).length, 1, 'Pending import cannot change saved events');
  releaseFirst(makeBackup('fictional-first', 'Fictional first'));
  await first;
  assert.equal(app.get('importBackup').disabled, false, 'Import button reenabled');
  let events = JSON.parse(app.stored.get(key));
  assert.equal(events.length, 2);
  assert.ok(events.some(x => x.key === 'fictional-first'));
  await onChange({target: {files: [secondFile], value: 'second.json'}});
  events = JSON.parse(app.stored.get(key));
  assert.equal(secondReads, 1);
  assert.equal(events.length, 3, 'Later intentional import must preserve the first import');
  assert.ok(events.some(x => x.key === saved.key));
  assert.ok(events.some(x => x.key === 'fictional-first'));
  assert.ok(events.some(x => x.key === 'fictional-second'));
});


test('backup import preserves an event saved by another tab while file is still reading', async () => {
  const shared = new Map();
  const importingTab = createApp(shared);
  importingTab.get('sampleEvent').click();
  importingTab.get('save').click();
  const key = 'feastlab-private-v1';
  const initial = JSON.parse(shared.get(key))[0];
  let finishReading;
  const delayedFile = {
    size: 1000,
    text: () => new Promise(resolve => { finishReading = resolve; }),
  };
  const importChange = importingTab.get('importFile').listeners.get('change');
  const pending = importChange({target: {files: [delayedFile], value: 'fictional-backup.json'}});
  assert.equal(importingTab.get('importBackup').disabled, true);

  // Simulate a second same-origin tab saving a new event during the async read.
  const otherTab = createApp(shared);
  otherTab.get('sampleEvent').click();
  otherTab.get('eventName').value = 'Fictional second-tab booking';
  otherTab.get('save').click();
  assert.equal(JSON.parse(shared.get(key)).length, 2);

  const incoming = {
    format: 'feastlab-backup-v1',
    events: [{
      ...initial,
      key: 'fictional-delayed-import',
      data: {...initial.data, eventName: 'Fictional imported booking'},
    }],
  };
  finishReading(JSON.stringify(incoming));
  await pending;
  const after = JSON.parse(shared.get(key));
  assert.equal(after.length, 3, 'Import must merge with latest saved records after file read');
  assert.ok(after.some(e => e.key === initial.key), 'Original saved event remains');
  assert.ok(after.some(e => e.data.eventName === 'Fictional second-tab booking'), 'Concurrent tab save remains');
  assert.ok(after.some(e => e.key === 'fictional-delayed-import'), 'Import completes');
  assert.equal(importingTab.get('importBackup').disabled, false);
});


test('backup import refuses corrupted storage introduced during a delayed file read', async () => {
  const shared = new Map();
  const app = createApp(shared);
  app.get('sampleEvent').click();
  app.get('save').click();
  const key = 'feastlab-private-v1';
  const existing = JSON.parse(shared.get(key))[0];
  let finishReading;
  const file = {size: 1000, text: () => new Promise(resolve => { finishReading = resolve; })};
  const pending = app.get('importFile').listeners.get('change')({target: {files: [file], value: 'fictional-delayed.json'}});
  const damaged = '{"damaged storage": [unreadable';
  shared.set(key, damaged);
  const incoming = {format: 'feastlab-backup-v1', events: [{
    ...existing, key: 'fictional-never-imported',
    data: {...existing.data, eventName: 'Fictional import blocked by damage'},
  }]};
  finishReading(JSON.stringify(incoming));
  await pending;
  assert.equal(shared.get(key), damaged, 'Import must preserve corrupted bytes for recovery');
  assert.match(app.get('errorBox').textContent, /Existing saved events are unreadable/);
  assert.equal(app.get('importBackup').disabled, false, 'Import control must recover after rejection');
});
