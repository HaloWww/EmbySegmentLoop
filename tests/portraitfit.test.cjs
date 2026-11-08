const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

class Events {
    constructor() { this.listeners = new Map(); }
    addEventListener(type, fn, options) {
        const entries = this.listeners.get(type) || [];
        entries.push({ fn, options }); this.listeners.set(type, entries);
    }
    removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter(x => x.fn !== fn)); }
    dispatch(type, values = {}) {
        const event = { target: this, button: 0, pointerId: 1, prevented: false, stopped: false,
            preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; },
            stopImmediatePropagation() { this.stopped = true; }, ...values };
        for (const entry of [...(this.listeners.get(type) || [])]) entry.fn(event);
        return event;
    }
    listenerCount() { return [...this.listeners.values()].reduce((count, value) => count + value.length, 0); }
}

class Style {
    constructor() { this.values = new Map(); }
    setProperty(name, value, priority = '') {
        if (value === '') this.values.delete(name); else this.values.set(name, [value, priority]);
    }
    getPropertyValue(name) { return (this.values.get(name) || [''])[0]; }
    getPropertyPriority(name) { return (this.values.get(name) || ['', ''])[1]; }
    removeProperty(name) { this.values.delete(name); }
}

class Element extends Events {
    constructor(doc, tag) {
        super(); this.ownerDocument = doc; this.tagName = tag.toUpperCase(); this.nodeType = 1;
        this.children = []; this.parentElement = null; this.attributes = new Map(); this.style = new Style();
        this.className = ''; this.textContent = ''; this.hidden = false; this.rect = { left: 0, top: 0, width: 900, height: 1600 };
        this.classList = {
            contains: name => this.className.split(/\s+/).includes(name),
            toggle: (name, enabled) => {
                const names = new Set(this.className.split(/\s+/).filter(Boolean));
                enabled ? names.add(name) : names.delete(name); this.className = [...names].join(' ');
            }
        };
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    appendChild(node) { node.remove(); node.parentElement = this; this.children.push(node); return node; }
    remove() {
        if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(x => x !== this);
        this.parentElement = null;
    }
    contains(other) { return this === other || this.children.some(child => child.contains?.(other)); }
    get isConnected() { return !!this.ownerDocument.documentElement?.contains(this); }
    getClientRects() { return this.isConnected && !this.hidden ? [this.getBoundingClientRect()] : []; }
    getBoundingClientRect() { return { ...this.rect, right: this.rect.left + this.rect.width, bottom: this.rect.top + this.rect.height }; }
    matches(selector) {
        selector = selector.trim();
        if (selector[0] === '.') return this.classList.contains(selector.slice(1));
        if (selector[0] === '[') {
            const match = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
            return !!match && this.attributes.has(match[1]) && (match[2] == null || this.getAttribute(match[1]) === match[2]);
        }
        return this.tagName.toLowerCase() === selector.toLowerCase();
    }
    closest(selector) {
        for (let node = this; node; node = node.parentElement) if (selector.split(',').some(part => node.matches(part))) return node;
        return null;
    }
    querySelectorAll(selector) {
        return this.children.flatMap(child => child.nodeType === 1
            ? [...(selector.split(',').some(part => child.matches(part)) ? [child] : []), ...child.querySelectorAll(selector)] : []);
    }
    setPointerCapture(id) { this.pointerCaptured = id; }
    releasePointerCapture() { this.pointerCaptured = null; }
}

class Doc extends Events {
    constructor(sharedStorage = new Map()) {
        super(); this.frames = []; this.observers = []; this.resizes = []; this.storage = sharedStorage;
        const doc = this;
        this.defaultView = Object.assign(new Events(), {
            innerWidth: 900, innerHeight: 1600,
            localStorage: { getItem: key => sharedStorage.get(key) || null, setItem: (key, value) => sharedStorage.set(key, value) },
            requestAnimationFrame: callback => { this.frames.push(callback); return this.frames.length; },
            cancelAnimationFrame: () => {},
            MutationObserver: class {
                constructor(callback) { this.callback = callback; doc.observers.push(this); }
                observe(target) { this.target = target; }
                disconnect() { this.disconnected = true; }
            },
            ResizeObserver: class {
                constructor(callback) { this.callback = callback; this.targets = []; doc.resizes.push(this); }
                observe(target) { this.targets.push(target); }
                disconnect() { this.disconnected = true; }
            }
        });
        this.newRoot();
    }
    newRoot() {
        this.documentElement = new Element(this, 'html'); this.head = new Element(this, 'head'); this.body = new Element(this, 'body');
        this.documentElement.appendChild(this.head); this.documentElement.appendChild(this.body);
    }
    createElement(tag) { return new Element(this, tag); }
    createTextNode(value) { const node = new Element(this, '#text'); node.nodeType = 3; node.textContent = value; return node; }
    getElementById(id) { return this.all().find(node => node.id === id) || null; }
    all(node = this.documentElement) { return node.children.flatMap(child => [child, ...this.all(child)]); }
    querySelectorAll(selector) { return this.documentElement.querySelectorAll(selector); }
    flush() { const callbacks = this.frames.splice(0); callbacks.forEach(callback => callback()); }
}

function addVideo(doc, className = 'htmlVideoPlayerContainer') {
    const host = doc.createElement('div'); host.className = className; doc.body.appendChild(host);
    const video = doc.createElement('video'); video.videoWidth = 1920; video.videoHeight = 1080;
    video.setAttribute('src', 'source.mp4'); video.currentSrc = 'source.mp4'; video.ended = false;
    video.style.setProperty('object-fit', 'contain', 'important');
    video.style.setProperty('object-position', '34% 20%');
    video.style.setProperty('cursor', 'crosshair'); video.style.setProperty('touch-action', 'pan-y');
    host.appendChild(video); return { host, video };
}

function harness() {
    const doc = new Doc(); const pair = addVideo(doc); const win = doc.defaultView;
    win.window = win; win.document = doc;
    const context = vm.createContext({ window: win, document: doc, console, WeakMap, JSON, isFinite });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../portraitfit.js'), 'utf8'), context);
    return { doc, win, api: win.EmbyPortraitFit, context, ...pair };
}

function findButton(doc, label) { return doc.querySelectorAll('button').find(button => button.textContent === label); }

test('cover geometry exposes the correct left, center and right crops for a rotated 16:9 screen', () => {
    const { api } = harness();
    const left = api.geometry(1920, 1080, 1080, 1920, 0);
    const center = api.geometry(1920, 1080, 1080, 1920, 50);
    const right = api.geometry(1920, 1080, 1080, 1920, 100);
    assert.equal(left.eligible, true);
    assert.equal(left.sourceLeft, 0);
    assert.equal(left.sourceWidth, 607.5);
    assert.equal(center.sourceLeft, 656.25);
    assert.equal(right.sourceLeft, 1312.5);
    assert.equal(api.geometry(1920, 1080, 1920, 1080, 50).eligible, false);
    assert.equal(api.geometry(1080, 1920, 1080, 1920, 50).eligible, false);
    assert.equal(api.geometry(1920, 1080, 0, 0, 50).eligible, false);
});

test('default preserves original video styling; cover is restored on landscape and re-applied on portrait resize', () => {
    const { api, doc, win, video, host } = harness();
    assert.equal(api.getState(video).mode, 'contain');
    assert.equal(video.style.getPropertyValue('object-position'), '34% 20%');
    api.set(video, { mode: 'cover', x: 25 });
    assert.equal(video.style.getPropertyValue('object-fit'), 'cover');
    assert.equal(video.style.getPropertyValue('object-position'), '25% 50%');
    host.rect = video.rect = { left: 0, top: 0, width: 1600, height: 900 };
    win.dispatch('resize'); doc.flush();
    assert.equal(api.getState(video).applied, false);
    assert.equal(video.style.getPropertyValue('object-fit'), 'contain');
    assert.equal(video.style.getPropertyPriority('object-fit'), 'important');
    assert.equal(video.style.getPropertyValue('object-position'), '34% 20%');
    host.rect = video.rect = { left: 0, top: 0, width: 900, height: 1600 };
    win.dispatch('resize'); doc.flush();
    assert.equal(api.getState(video).applied, true);
    assert.equal(video.style.getPropertyValue('object-position'), '25% 50%');
});

test('multiple videos retain independent positions while future videos use saved browser preferences', () => {
    const { api, doc, video } = harness();
    const second = addVideo(doc, 'tile').video; api.attach(doc);
    api.set(video, { mode: 'cover', x: 0 });
    assert.equal(api.getState(second).mode, 'contain');
    api.set(second, { mode: 'cover', x: 100 });
    assert.equal(api.getState(video).x, 0);
    assert.equal(api.getState(second).x, 100);
    const third = addVideo(doc, 'tile').video; api.attach(doc);
    assert.equal(api.getState(third).mode, 'cover');
    assert.equal(api.getState(third).x, 100);
});

test('drag mode translates screen movement to crop coordinates without consuming player control clicks', () => {
    const { api, doc, video } = harness();
    api.set(video, { mode: 'cover', x: 50 });
    findButton(doc, '竖屏填充').dispatch('click');
    findButton(doc, '拖动选择画面').dispatch('click');
    assert.equal(api.getState(video).editing, true);
    const control = findButton(doc, '完成画面选择');
    assert.equal(doc.dispatch('pointerdown', { target: control, clientX: 450, clientY: 800 }).prevented, false);
    assert.equal(doc.dispatch('pointerdown', { target: video, clientX: 450, clientY: 800 }).prevented, true);
    const overflow = api.geometry(1920, 1080, 900, 1600, 50).overflow;
    doc.dispatch('pointermove', { target: video, clientX: 550, clientY: 800 });
    assert.ok(Math.abs(api.getState(video).x - (50 - 100 / overflow * 100)) < .0001);
    doc.dispatch('pointerup', { target: video });
    assert.equal(video.pointerCaptured, null);
    assert.equal(doc.dispatch('click', { target: video, clientX: 550, clientY: 800 }).prevented, true);
    assert.equal(doc.dispatch('click', { target: control, clientX: 550, clientY: 800 }).prevented, false);
    doc.dispatch('keydown', { key: 'Escape' });
    assert.equal(api.getState(video).editing, false);
    assert.equal(video.style.getPropertyValue('cursor'), 'crosshair');
    assert.equal(video.style.getPropertyValue('touch-action'), 'pan-y');
});

test('ended and emptied restore the player; replay reapplies the requested fill without editing residue', () => {
    const { api, doc, video } = harness();
    api.set(video, { mode: 'cover', x: 80 });
    findButton(doc, '竖屏填充').dispatch('click'); findButton(doc, '拖动选择画面').dispatch('click');
    video.dispatch('ended');
    assert.equal(api.getState(video).applied, false);
    assert.equal(api.getState(video).editing, false);
    assert.equal(video.style.getPropertyValue('object-position'), '34% 20%');
    video.dispatch('play'); assert.equal(api.getState(video).applied, true);
    video.dispatch('emptied'); assert.equal(api.getState(video).applied, false);
    video.setAttribute('src', 'next.mp4'); video.currentSrc = 'next.mp4';
    video.dispatch('loadedmetadata');
    assert.equal(api.getState(video).applied, true);
    assert.equal(api.getState(video).editing, false);
    assert.equal(doc.querySelectorAll('.embyPortraitFitTools').length, 1);
});

test('attach is idempotent and removing a video releases its listeners and resize observer', () => {
    const { api, doc, win, video, host } = harness();
    const count = win.listenerCount() + doc.listenerCount() + video.listenerCount();
    const handle = api.attach(doc); assert.equal(api.attach(doc), handle);
    assert.equal(win.listenerCount() + doc.listenerCount() + video.listenerCount(), count);
    assert.equal(doc.querySelectorAll('.embyPortraitFitTools').length, 1);
    api.set(video, { mode: 'cover' }); host.remove(); handle.refresh();
    assert.equal(api.getState(video), null); assert.equal(video.listenerCount(), 0);
    assert.equal(doc.resizes[0].disconnected, true);
    assert.equal(video.style.getPropertyValue('object-fit'), 'contain');
});

test('detaching restores all overridden sizing and priorities and removes every document listener', () => {
    const { api, doc, win, video, host } = harness();
    video.rect.height = 506; video.style.setProperty('width', '900px'); video.style.setProperty('height', '506px', 'important');
    api.set(video, { mode: 'cover' });
    assert.equal(video.style.getPropertyValue('width'), '100%');
    api.detach(doc);
    assert.equal(video.style.getPropertyValue('width'), '900px');
    assert.equal(video.style.getPropertyValue('height'), '506px');
    assert.equal(video.style.getPropertyPriority('height'), 'important');
    assert.equal(video.style.getPropertyValue('object-fit'), 'contain');
    assert.equal(win.listenerCount(), 0); assert.equal(doc.listenerCount(), 0); assert.equal(video.listenerCount(), 0);
    assert.equal(doc.getElementById('embyPortraitFitStyle'), null);
    assert.equal(doc.querySelectorAll('.embyPortraitFitTools').length, 0);
});

test('a root replacement used by Tampermonkey gets fresh style and video bindings on the same Document', () => {
    const { api, doc, video } = harness();
    assert.equal(doc.observers[0].target, doc);
    const handle = api.attach(doc); doc.newRoot();
    const replacement = addVideo(doc, 'tile').video;
    handle.refresh();
    assert.equal(api.getState(video), null); assert.equal(video.listenerCount(), 0);
    assert.ok(api.getState(replacement));
    assert.ok(doc.getElementById('embyPortraitFitStyle'));
    assert.equal(doc.querySelectorAll('.embyPortraitFitTools').length, 1);
});

test('fullscreen relocates controls within its root; native video fullscreen hides unavailable HTML tools', () => {
    const { api, doc, host, video } = harness();
    api.set(video, { mode: 'cover' });
    doc.fullscreenElement = host; doc.dispatch('fullscreenchange'); doc.flush();
    const ui = doc.querySelectorAll('.embyPortraitFitTools')[0];
    assert.equal(ui.parentElement, host);
    doc.fullscreenElement = video; doc.dispatch('fullscreenchange'); doc.flush();
    assert.equal(ui.hidden, true);
    doc.fullscreenElement = null; doc.dispatch('fullscreenchange'); doc.flush();
    assert.equal(ui.parentElement, doc.body); assert.equal(ui.hidden, false);
    api.set(video, { mode: 'contain' }); assert.equal(video.style.getPropertyValue('object-fit'), 'contain');
});

test('same-origin frame bindings are detached when the frame is removed', () => {
    const { api, doc } = harness();
    const frame = doc.createElement('iframe'); const child = new Doc(doc.storage); const video = addVideo(child, 'tile').video;
    frame.contentDocument = child; doc.body.appendChild(frame); api.attach(doc);
    assert.ok(api.getState(video)); assert.ok(child.listenerCount());
    frame.remove(); api.attach(doc);
    assert.equal(api.getState(video), null); assert.equal(child.listenerCount(), 0); assert.equal(video.listenerCount(), 0);
});

test('native video fullscreen uses its own dimensions instead of a stale portrait parent', () => {
    const { api, doc, host, video } = harness();
    api.set(video, { mode: 'cover' }); assert.equal(api.getState(video).applied, true);
    assert.equal(host.rect.width, 900); assert.equal(host.rect.height, 1600);
    video.rect = { left: 0, top: 0, width: 1920, height: 1080 };
    doc.fullscreenElement = video; doc.dispatch('fullscreenchange'); doc.flush();
    assert.equal(api.getState(video).eligible, false);
    assert.equal(api.getState(video).applied, false);
    assert.equal(video.style.getPropertyValue('object-fit'), 'contain');
});

test('an open Emby panel stays outside the auto-hidden OSD and returns to its toolbar when closed', () => {
    const { api, doc, video } = harness();
    const osd = doc.createElement('div'); const toolbar = doc.createElement('div');
    toolbar.className = 'videoOsdBottom-buttons-topright'; osd.appendChild(toolbar); doc.body.appendChild(osd);
    api.attach(doc);
    const tools = doc.querySelectorAll('.embyPortraitFitTools')[0];
    assert.equal(tools.parentElement, toolbar);
    findButton(doc, '竖屏填充').dispatch('click');
    assert.equal(tools.parentElement, doc.body);
    osd.hidden = true; api.attach(doc);
    assert.equal(tools.parentElement, doc.body); assert.equal(tools.hidden, false);
    doc.dispatch('keydown', { key: 'Escape' });
    assert.equal(tools.parentElement, toolbar);
    assert.equal(api.getState(video).editing, false);
});

test('closing a same-origin popup detaches it while bfcache pagehide preserves bindings', () => {
    const { api, doc, win, video } = harness();
    api.set(video, { mode: 'cover' }); win.dispatch('pagehide', { persisted: true });
    assert.ok(api.getState(video));
    win.dispatch('pagehide', { persisted: false });
    assert.equal(api.getState(video), null); assert.equal(win.listenerCount(), 0); assert.equal(doc.listenerCount(), 0);
    assert.equal(video.style.getPropertyValue('object-fit'), 'contain');
});
