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
    get clientWidth() { return this._clientWidth == null ? this.rect.width : this._clientWidth; }
    set clientWidth(value) { this._clientWidth = value; }
    get clientHeight() { return this._clientHeight == null ? this.rect.height : this._clientHeight; }
    set clientHeight(value) { this._clientHeight = value; }
    getBoundingClientRect() {
        let rect = { ...this.rect };
        if (this.simulateTransform) {
            const scale = Number((this.style.getPropertyValue('transform').match(/scale\(([^)]+)\)/) || [0, 1])[1]);
            const origin = this.style.getPropertyValue('transform-origin').split(' ').map(Number.parseFloat);
            rect.left += (1 - scale) * rect.width * (Number.isFinite(origin[0]) ? origin[0] : 50) / 100;
            rect.top += (1 - scale) * rect.height * (Number.isFinite(origin[1]) ? origin[1] : 50) / 100;
            rect.width *= scale; rect.height *= scale;
        }
        return { ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height };
    }
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
            getComputedStyle: node => ({ getPropertyValue: name => node.style.getPropertyValue(name) || (node.computedStyle || {})[name] || '' }),
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

function harness(options = {}) {
    const doc = new Doc(); const pair = addVideo(doc); const win = doc.defaultView;
    if (options.preferences) doc.storage.set('embyPortraitFit.v1', JSON.stringify(options.preferences));
    if (options.setup) options.setup(pair.video, pair.host, doc);
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
    assert.equal(api.geometry(1920, 1080, 1920, 1080, 50).eligible, true);
    assert.equal(api.geometry(1080, 1920, 1080, 1920, 50).eligible, true);
    assert.equal(api.geometry(1920, 1080, 0, 0, 50).eligible, false);
});

test('default explicitly fits complete video and cover works on both portrait and landscape screens', () => {
    const { api, doc, win, video, host } = harness();
    assert.equal(api.getState(video).mode, 'contain');
    assert.equal(video.style.getPropertyValue('object-position'), '50% 50%');
    api.set(video, { mode: 'cover', x: 25 });
    assert.equal(video.style.getPropertyValue('object-fit'), 'cover');
    assert.equal(video.style.getPropertyValue('object-position'), '25% 50%');
    host.rect = video.rect = { left: 0, top: 0, width: 1600, height: 900 };
    win.dispatch('resize'); doc.flush();
    assert.equal(api.getState(video).applied, true);
    assert.equal(video.style.getPropertyValue('object-fit'), 'cover');
    assert.equal(video.style.getPropertyPriority('object-fit'), 'important');
    assert.equal(video.style.getPropertyValue('object-position'), '50% 50%');
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
    findButton(doc, '画面缩放').dispatch('click');
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
    findButton(doc, '画面缩放').dispatch('click'); findButton(doc, '拖动选择画面').dispatch('click');
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
    const { api, doc, win, video, host } = harness({ setup(video) {
        video.rect.height = 506; video.style.setProperty('width', '900px'); video.style.setProperty('height', '506px', 'important');
    } });
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
    assert.equal(api.getState(video).eligible, true);
    assert.equal(api.getState(video).applied, true);
    assert.equal(video.style.getPropertyValue('object-fit'), 'cover');
    const sliders = doc.querySelectorAll('input');
    assert.equal(sliders.find(input => input.getAttribute('aria-label') === '裁切水平位置').disabled, true);
    assert.equal(sliders.find(input => input.getAttribute('aria-label') === '裁切垂直位置').disabled, true);
});

test('an open Emby panel stays outside the auto-hidden OSD and returns to its toolbar when closed', () => {
    const { api, doc, video } = harness();
    const osd = doc.createElement('div'); const toolbar = doc.createElement('div');
    toolbar.className = 'videoOsdBottom-buttons-topright'; osd.appendChild(toolbar); doc.body.appendChild(osd);
    api.attach(doc);
    const tools = doc.querySelectorAll('.embyPortraitFitTools')[0];
    assert.equal(tools.parentElement, toolbar);
    findButton(doc, '画面缩放').dispatch('click');
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

function slider(doc, label) { return doc.querySelectorAll('input').find(input => input.getAttribute('aria-label') === label); }

test('contain and cover geometry supports every video/screen ratio with bounded two-axis crops', () => {
    const { api } = harness();
    for (const media of [[1920, 1080], [1080, 1920], [1000, 1000]]) {
        for (const viewport of [[1600, 900], [900, 1600], [800, 800]]) {
            for (const mode of ['contain', 'cover']) {
                for (const zoom of [1, 2, 5]) {
                    for (const position of [0, 50, 100]) {
                        const shape = api.geometry(...media, ...viewport, position, position, zoom, mode);
                        assert.equal(shape.eligible, true);
                        assert.ok(shape.sourceLeft >= 0 && shape.sourceTop >= 0);
                        assert.ok(shape.sourceLeft + shape.sourceWidth <= media[0] + .001);
                        assert.ok(shape.sourceTop + shape.sourceHeight <= media[1] + .001);
                        if (zoom === 1 && mode === 'contain') {
                            assert.equal(shape.overflowX, 0); assert.equal(shape.overflowY, 0);
                            assert.ok(Math.abs(shape.sourceWidth - media[0]) < .001);
                            assert.ok(Math.abs(shape.sourceHeight - media[1]) < .001);
                        }
                    }
                }
            }
        }
    }
});

test('each position slider is enabled only when that axis actually overflows', () => {
    const { api, doc, video } = harness();
    api.set(video, { mode: 'contain', zoom: 1 });
    assert.equal(slider(doc, '裁切水平位置').disabled, true);
    assert.equal(slider(doc, '裁切垂直位置').disabled, true);
    api.set(video, { zoom: 2 });
    assert.equal(slider(doc, '裁切水平位置').disabled, false);
    assert.equal(slider(doc, '裁切垂直位置').disabled, true);
    api.set(video, { zoom: 4 });
    assert.equal(slider(doc, '裁切垂直位置').disabled, false);
    const scale = slider(doc, '缩放倍率'); scale.value = '250'; scale.dispatch('input');
    assert.equal(api.getState(video).zoom, 2.5);
});

test('zoom and positions clamp to bounds and legacy cover preferences migrate without changing the old crop', () => {
    const { api, doc, video } = harness({ preferences: { mode: 'cover', x: 100 } });
    assert.equal(api.getState(video).mode, 'cover'); assert.equal(api.getState(video).zoom, 1);
    assert.equal(api.getState(video).x, 100); assert.equal(api.getState(video).y, 50);
    api.set(video, { zoom: 20, x: -30, y: 200 });
    assert.equal(api.getState(video).zoom, 5); assert.equal(api.getState(video).x, 0); assert.equal(api.getState(video).y, 100);
    api.set(video, { zoom: 0 }); assert.equal(api.getState(video).zoom, 1);
    api.set(video, { zoom: 'bad', x: NaN, y: Infinity });
    assert.equal(api.getState(video).zoom, 1); assert.equal(api.getState(video).x, 50); assert.equal(api.getState(video).y, 50);
    const saved = JSON.parse(doc.storage.get('embyPortraitFit.v1'));
    assert.deepEqual(saved, { mode: 'cover', x: 50, y: 50, zoom: 1 });
});

test('two-axis dragging pans only the content overflow and clamps both edges', () => {
    const { api, doc, video } = harness({ setup(video, host) {
        video.videoWidth = video.videoHeight = 1000;
        video.rect = host.rect = { left: 0, top: 0, width: 800, height: 800 };
    } });
    api.set(video, { mode: 'contain', zoom: 2, x: 50, y: 50 });
    findButton(doc, '画面缩放').dispatch('click'); findButton(doc, '拖动选择画面').dispatch('click');
    doc.dispatch('pointerdown', { target: video, clientX: 400, clientY: 400 });
    doc.dispatch('pointermove', { target: video, clientX: 480, clientY: 240 });
    assert.equal(api.getState(video).x, 40); assert.equal(api.getState(video).y, 70);
    doc.dispatch('pointermove', { target: video, clientX: 3000, clientY: -3000 });
    assert.equal(api.getState(video).x, 0); assert.equal(api.getState(video).y, 100);
    assert.equal(doc.dispatch('dblclick', { target: video, clientX: 300, clientY: 400 }).prevented, true);
    doc.dispatch('pointerup', { target: video });
    findButton(doc, '完成画面选择').dispatch('click');
    assert.equal(doc.dispatch('dblclick', { target: video, clientX: 300, clientY: 400 }).prevented, false);
});

test('a scaled video cannot capture drag events inside a different tile', () => {
    const { api, doc, video, host } = harness({ setup(video, host) {
        host.className = 'tile'; host.rect = video.rect = { left: 0, top: 0, width: 500, height: 500 };
    } });
    const second = addVideo(doc, 'tile'); second.host.rect = second.video.rect = { left: 500, top: 0, width: 500, height: 500 };
    api.attach(doc); api.set(video, { zoom: 5 });
    findButton(doc, '画面缩放').dispatch('click'); findButton(doc, '拖动选择画面').dispatch('click');
    video.simulateTransform = true;
    assert.ok(video.getBoundingClientRect().right > 500);
    const event = doc.dispatch('pointerdown', { target: second.video, clientX: 600, clientY: 250 });
    assert.equal(event.prevented, false); assert.equal(video.pointerCaptured, undefined);
});

test('resizing a transformed player uses stable layout dimensions and content origin', () => {
    const { api, doc, video, host } = harness(); video.simulateTransform = true;
    api.set(video, { mode: 'contain', zoom: 4, x: 20, y: 80 });
    const handle = api.attach(doc); const first = video.style.getPropertyValue('transform-origin');
    for (let i = 0; i < 10; i++) handle.refresh();
    assert.equal(api.getState(video).zoom, 4);
    assert.equal(video.style.getPropertyValue('transform'), 'scale(4)');
    assert.equal(video.style.getPropertyValue('transform-origin'), first);
    host.rect = video.rect = { left: 0, top: 0, width: 1600, height: 900 };
    handle.refresh();
    assert.equal(video.style.getPropertyValue('transform-origin'), '20% 80%');
    assert.equal(api.getState(video).zoom, 4);
});

test('viewport measurement excludes a tile border and does not invent an overflow at 100 percent', () => {
    const { api, doc, video } = harness({ setup(video, host) {
        host.rect = { left: 0, top: 0, width: 642, height: 362 };
        host.clientWidth = 640; host.clientHeight = 360; host.clientLeft = host.clientTop = 1;
        video.rect = { left: 1, top: 1, width: 640, height: 360 };
    } });
    api.set(video, { mode: 'cover', zoom: 1 });
    assert.equal(slider(doc, '裁切水平位置').disabled, true);
    assert.equal(slider(doc, '裁切垂直位置').disabled, true);
});

test('reset releases clipping and restores transforms while detach restores every original inline property', () => {
    const { api, doc, video, host } = harness({ setup(video, host) {
        video.style.setProperty('transform', 'translate(-50%, -50%)', 'important');
        video.style.setProperty('transform-origin', '25% 35%');
        host.style.setProperty('overflow', 'visible'); host.style.setProperty('touch-action', 'pan-y');
    } });
    api.set(video, { mode: 'cover', zoom: 3, x: 10, y: 90 });
    assert.equal(host.style.getPropertyValue('overflow'), 'hidden');
    assert.equal(host.style.getPropertyPriority('overflow'), 'important');
    assert.ok(video.style.getPropertyValue('transform').includes('translate(-50%, -50%) scale(3)'));
    findButton(doc, '重置画面').dispatch('click');
    const state = api.getState(video);
    assert.equal(state.mode, 'contain'); assert.equal(state.zoom, 1); assert.equal(state.x, 50); assert.equal(state.y, 50);
    assert.equal(host.style.getPropertyValue('overflow'), 'visible');
    assert.equal(video.style.getPropertyValue('transform'), 'translate(-50%, -50%)');
    assert.equal(video.style.getPropertyPriority('transform'), 'important');
    assert.equal(video.style.getPropertyValue('transform-origin'), '25% 35%');
    api.detach(doc);
    assert.equal(video.style.getPropertyValue('object-position'), '34% 20%');
    assert.equal(host.style.getPropertyValue('touch-action'), 'pan-y');
    assert.equal(host.style.getPropertyPriority('touch-action'), '');
});

test('stylesheet centering transform is recomputed after resize and is not accumulated', () => {
    const { api, doc, video, host } = harness({ setup(video, host, doc) {
        doc.defaultView.getComputedStyle = node => ({ getPropertyValue(name) {
            if (name === 'transform' && node === video) return node.style.getPropertyValue(name) || `matrix(1,0,0,1,${-video.clientWidth / 2},${-video.clientHeight / 2})`;
            return node.style.getPropertyValue(name);
        } });
    } });
    api.set(video, { zoom: 2 });
    assert.equal(video.style.getPropertyValue('transform'), 'matrix(1,0,0,1,-450,-800) scale(2)');
    host.rect = video.rect = { left: 0, top: 0, width: 1600, height: 900 };
    api.attach(doc);
    assert.equal(video.style.getPropertyValue('transform'), 'matrix(1,0,0,1,-800,-450) scale(2)');
    api.attach(doc); assert.equal(video.style.getPropertyValue('transform'), 'matrix(1,0,0,1,-800,-450) scale(2)');
    api.detach(doc); assert.equal(video.style.getPropertyValue('transform'), '');
});

test('shared viewport retains clipping until its final zoomed video is reset and preserves touch priority', () => {
    const { api, doc, video, host } = harness({ setup(video, host) {
        host.style.setProperty('overflow', 'visible'); host.style.setProperty('touch-action', 'pan-y');
    } });
    const second = addVideo(doc).video; host.appendChild(second); api.attach(doc);
    api.set(video, { zoom: 2 }); api.set(second, { zoom: 3 });
    api.set(video, { zoom: 1 });
    assert.equal(host.style.getPropertyValue('overflow'), 'hidden');
    assert.equal(host.style.getPropertyValue('touch-action'), 'pan-y');
    assert.equal(host.style.getPropertyPriority('touch-action'), '');
    api.set(second, { zoom: 1 });
    assert.equal(host.style.getPropertyValue('overflow'), 'visible');
});

test('loading version 2 replaces a legacy API once; loading version 2 again is idempotent', () => {
    const doc = new Doc(); const pair = addVideo(doc); const win = doc.defaultView;
    let removed = 0, oldAttach = 0;
    win.EmbyPortraitFit = { version: '1.0.0', attach() { oldAttach++; }, detach(target) { assert.equal(target, doc); removed++; } };
    const context = vm.createContext({ window: win, document: doc, console, WeakMap, JSON, isFinite });
    const source = fs.readFileSync(path.join(__dirname, '../portraitfit.js'), 'utf8');
    vm.runInContext(source, context);
    assert.equal(removed, 1); assert.equal(oldAttach, 0); assert.equal(win.EmbyPortraitFit.version, '2.0.0');
    const count = pair.video.listenerCount() + doc.listenerCount();
    vm.runInContext(source, context);
    assert.equal(pair.video.listenerCount() + doc.listenerCount(), count);
    assert.equal(doc.querySelectorAll('.embyPortraitFitTools').length, 1);
});

test('tool keyboard events keep native range and button defaults without reaching player hotkeys', () => {
    const { doc } = harness(); const tools = doc.querySelectorAll('.embyPortraitFitTools')[0];
    const range = slider(doc, '缩放倍率');
    for (const key of [' ', 'f', 'm', 'ArrowLeft', 'ArrowUp', 'Home', 'End', 'Tab']) {
        for (const name of ['keydown', 'keyup']) {
            const event = tools.dispatch(name, { key, target: range });
            assert.equal(event.stopped, true, `${name} ${key} must stay out of player hotkeys`);
            assert.equal(event.prevented, false, `${name} ${key} must keep the native control default`);
        }
    }
    const event = tools.dispatch('keydown', { key: ' ', target: findButton(doc, '重置画面') });
    assert.equal(event.stopped, true); assert.equal(event.prevented, false);
});
