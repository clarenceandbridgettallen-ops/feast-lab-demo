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

function createApp(sharedStorage = null) {
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
  vm.runInNewContext(source, {document, window, localStorage, Blob, URL, Intl, console, setTimeout, clearTimeout}, {timeout: 2000});
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
