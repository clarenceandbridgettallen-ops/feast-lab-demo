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

function createApp() {
  const ids = ['eventName','eventDate','guests','margin','tax','discount','serviceFee','deposit','food','labor','overhead','other'];
  const defaults = {guests:'40',margin:'30',tax:'0',discount:'0',serviceFee:'0',deposit:'30',food:'240',labor:'150',overhead:'60',other:'39'};
  const elements = new Map();
  const get = id => { if (!elements.has(id)) elements.set(id, mockElement(id)); return elements.get(id); };
  for (const id of ids) get(id).value = defaults[id] ?? '';
  const stored = new Map();
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
  return {get, stored, localStorage, windowEvents, writes: () => writes};
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
