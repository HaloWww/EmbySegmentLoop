const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function harness(api = {}) {
    const storage = new Map();
    const video = {
        isConnected: true, getClientRects: () => [1], parentElement: null,
        getAttribute: () => null, classList: { contains: () => false },
        src: 'video.mp4', currentSrc: 'video.mp4', readyState: 4,
        currentTime: 20, paused: false, ended: false, seeking: false,
        playCalls: 0, play() { this.playCalls++; return Promise.resolve(); }
    };
    const context = {
        console, Promise, Date, setTimeout: () => 0, clearTimeout() {},
        location: { href: 'http://localhost/web/index.html#!/item?id=1' },
        localStorage: { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v) },
        sessionStorage: { getItem: () => null, setItem() {} },
        document: {
            body: { appendChild() {} },
            createElement: () => ({ remove() {} }),
            querySelectorAll: selector => selector === 'video' ? [video] : [],
            querySelector: () => null
        },
        ApiClient: {
            getUrl: path => path, getCurrentUserId: () => 'user',
            getJSON: async () => ({ Segments: [], Revision: 'empty' }),
            ajax: async () => ({ Revision: 'saved' }), ...api
        }
    };
    context.window = context;
    vm.createContext(context);
    const source = fs.readFileSync(require('node:path').join(__dirname, '../segmentloop.js'), 'utf8');
    const prefix = source.slice(0, source.indexOf('    window.EmbySegLoop ='));
    vm.runInContext(prefix + `
        renderAll = function () {};
        window.toasts = [];
        showToast = function (message) { window.toasts.push(message); };
        window.testApi = { parseTime, formatFileSize, getDetailItemInfo, renderDetailInfo, fillDetailHost, saveSegment, getItemSegments,
            ensureItemLoaded, setItemSegments, onVideoTimeUpdate, rememberPlaybackItemId, getPlaybackTimeMs, seekVideo,
            copySegments, getSegmentClipboard, segmentClipboardKey, appendCopiedSegments, pasteSegments, isSegmentTimeValid,
            setEditor: value => { openEditor = value; },
            renderCardHighlights, scheduleCardHighlights, loadShortcutConfiguration,
            setHighlightMode: value => { shortcutConfigurationLoaded = true; window.EmbySegmentLoopConfig = { cardHighlightMode: value }; },
            setActive: value => { activeSegment = value; }, getActive: () => activeSegment,
            setManager: value => { resolvedPlaybackManager = value; } };
    }());`, context);
    return { api: context.testApi, video, storage, context };
}

test('copy one or all preserves order and timing without writing to the source, with user-scoped cross-tab storage', async () => {
    const source = [
        { Id: 'a', Name: '片段 7', StartMs: 1001, EndMs: 2002, Order: 1 },
        { Id: 'b', Name: '中文名字', StartMs: 3003, EndMs: 4004, Order: 2 }
    ];
    let posts = 0;
    const { api, context, storage } = harness({ getJSON: async () => ({ Segments: source, Revision: 'source-r' }),
        ajax: async () => { posts++; return { Revision: 'r' }; } });
    assert.equal(await api.copySegments('source', { id: 'b' }), true);
    assert.equal(api.getSegmentClipboard().segments.length, 1);
    assert.equal(api.getSegmentClipboard().segments[0].startMs, 3003);
    assert.equal(await api.copySegments('source'), true);
    assert.deepEqual(JSON.parse(JSON.stringify(api.getSegmentClipboard().segments)), [
        { name: '片段 7', startMs: 1001, endMs: 2002 }, { name: '中文名字', startMs: 3003, endMs: 4004 }
    ]);
    assert.equal(posts, 0);
    const otherTab = harness();
    otherTab.context.localStorage.getItem = key => storage.get(key);
    assert.equal(otherTab.api.getSegmentClipboard().segments.length, 2);
    context.ApiClient.getCurrentUserId = () => 'another-user';
    assert.equal(api.getSegmentClipboard(), null);
    context.ApiClient.getCurrentUserId = () => 'user';
    context.ApiClient.getUrl = path => 'other-server/' + path;
    assert.equal(api.getSegmentClipboard(), null);
});

test('paste appends fresh IDs, preserves all names and existing segments, and waits for explicit preview save', async () => {
    const posted = [];
    let preview;
    const { api, context } = harness({
        getJSON: async url => ({ Segments: url.endsWith('/source')
            ? [{ Id: 'same', Name: '片段 7', StartMs: 1001, EndMs: 2002, Order: 1 }]
            : [{ Id: 'same', Name: '已有片段', StartMs: 0, EndMs: 1000, Order: 1 }], Revision: 'loaded' }),
        getItem: async () => ({ MediaType: 'Video', RunTimeTicks: 100000000 }),
        ajax: async request => { posted.push(JSON.parse(request.data)); return { Revision: 'saved' }; }
    });
    await api.copySegments('source');
    context.location.href = 'http://localhost/web/index.html#!/item?id=target';
    api.setEditor((id, single, paste) => { preview = { id, paste }; });
    assert.equal(await api.pasteSegments('target'), true);
    assert.equal(posted.length, 0);
    assert.equal(preview.id, 'target');
    assert.equal(preview.paste.durationMs, 10000);
    const current = api.getItemSegments('target');
    const draft = api.appendCopiedSegments(current, preview.paste.segments);
    assert.equal(draft.length, 2);
    assert.equal(current.length, 1);
    assert.equal(draft[0].id, 'same');
    assert.notEqual(draft[1].id, 'same');
    assert.equal(draft[1].name, '片段 7');
    assert.equal(draft[1].startMs, 1001);
    assert.equal(draft[1].order, 2);
    assert.notEqual(api.appendCopiedSegments(current, preview.paste.segments)[1].id, draft[1].id);
    assert.equal(await api.setItemSegments('target', draft, { preserveNames: true }), true);
    assert.equal(posted[0].ExpectedRevision, 'loaded');
    assert.equal(posted[0].Segments[1].name, '片段 7');
    assert.equal(posted[0].Segments[0].name, '已有片段');
    assert.equal(posted[0].ItemId, 'target');
});

test('invalid clipboard and failed target load cannot open a paste editor or write media data', async () => {
    let posts = 0, previews = 0;
    const { api, context, storage } = harness({
        getJSON: async url => { if (url.endsWith('/target')) throw Error('offline'); return { Segments: [
            { Id: 's', Name: '片段', StartMs: 1, EndMs: 2, Order: 1 }], Revision: 'r' }; },
        getItem: async () => ({ MediaType: 'Video' }), ajax: async () => { posts++; }
    });
    api.setEditor(() => previews++);
    context.location.href = 'http://localhost/web/index.html#!/item?id=target';
    assert.equal(await api.pasteSegments('target'), false);
    await api.copySegments('source');
    assert.equal(await api.pasteSegments('target'), false);
    assert.equal(previews, 0);
    assert.equal(posts, 0);
    for (const value of ['broken JSON', JSON.stringify({ version: 1, segments: [{ name: 'bad', startMs: -1, endMs: 2 }] }),
        JSON.stringify({ version: 1, segments: [{ name: 'bad', startMs: 1, endMs: 1 }] }),
        JSON.stringify({ version: 1, segments: new Array(1001).fill({ name: 'x', startMs: 1, endMs: 2 }) })]) {
        storage.set(api.segmentClipboardKey(), value);
        assert.equal(api.getSegmentClipboard(), null);
    }
});

test('storage write failure still pastes the newly copied content in the current tab', async () => {
    const { api, context } = harness({ getJSON: async () => ({ Segments: [
        { Id: 's', Name: '新复制', StartMs: 5, EndMs: 10, Order: 1 }], Revision: 'r' }) });
    context.localStorage.getItem = () => JSON.stringify({ version: 1, segments: [{ name: '旧复制', startMs: 1, endMs: 2 }] });
    context.localStorage.setItem = () => { throw Error('quota'); };
    assert.equal(await api.copySegments('source'), true);
    assert.equal(api.getSegmentClipboard().segments[0].name, '新复制');
    assert.match(context.toasts.at(-1), /仅当前标签页/);
});

test('paste time validation accepts the exact video end and rejects ranges beyond the target duration', () => {
    const { api } = harness();
    assert.equal(api.isSegmentTimeValid(1001, 10000, 10000), true);
    assert.equal(api.isSegmentTimeValid(1001, 10001, 10000), false);
    assert.equal(api.isSegmentTimeValid(1001, 20000, null), true);
    for (const times of [[-1, 2000], [1000, 1000], [2000, 1000], [NaN, 2000], [0, Infinity]])
        assert.equal(api.isSegmentTimeValid(...times, 10000), false);
});

test('time input accepts milliseconds and rejects extra fields, negative and invalid clock components', () => {
    const { api } = harness();
    assert.equal(api.parseTime('0:01:23.250'), 83250);
    assert.equal(api.parseTime('83.250'), 83250);
    assert.equal(api.parseTime('75:00'), 4500000);
    for (const value of ['1:2:3:4', '-1:20', '1:60:00', '1:99', '1::2', ':'])
        assert.ok(Number.isNaN(api.parseTime(value)), value);
});

function cardHarness(mode, items, getJSON) {
    const result = harness({ getJSON, getUrl: (path, options) => {
        assert.ok(path, 'Emby ApiClient requires a non-empty URL path');
        return path + (options ? '?ItemIds=' + options.ItemIds : '');
    } });
    const cards = items.map(item => {
        const classes = new Set();
        const image = { classList: { toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name) } };
        const card = {
            isConnected: true, parentElement: null, getClientRects: () => [1], getAttribute: () => null,
            classList: { contains: () => false },
            closest: () => ({ getItemFromElement: () => item }),
            querySelector: selector => selector === '.cardImageContainer' ? image
                : { getAttribute: () => item.UserData && item.UserData.IsFavorite ? 'true' : 'false' },
            classes
        };
        return card;
    });
    result.context.document.querySelectorAll = selector => selector === '.card' ? cards : [];
    result.api.setHighlightMode(mode);
    return { ...result, cards };
}

test('favorites mode uses current user favorite state and ignores people or folders without requests', () => {
    let calls = 0;
    const items = [
        { Id: '1', MediaType: 'Video', UserData: { IsFavorite: true } },
        { Id: '2', Type: 'Person', UserData: { IsFavorite: true } },
        { Id: '3', Type: 'Movie', IsFolder: true, UserData: { IsFavorite: true } }
    ];
    const { api, cards } = cardHarness('Favorites', items, async () => { calls++; });
    api.renderCardHighlights();
    assert.ok(cards[0].classes.has('embySegmentFavoriteCard'));
    assert.equal(cards[1].classes.size, 0);
    assert.equal(cards[2].classes.size, 0);
    items[0].UserData.IsFavorite = false;
    api.renderCardHighlights();
    assert.equal(cards[0].classes.size, 0);
    assert.equal(calls, 0);
});

test('both mode batches duplicate cards, caches segment state and clears borders when disabled', async () => {
    let calls = 0, complete;
    const { api, cards } = cardHarness('Both', [
        { Id: '1', Type: 'Movie', UserData: { IsFavorite: true } },
        { Id: '1', Type: 'Video' }, { Id: '2', Type: 'Episode' }
    ], url => {
        calls++;
        assert.equal(url, 'SegmentLoop/Highlights?ItemIds=1,2');
        return new Promise(resolve => { complete = resolve; });
    });
    api.renderCardHighlights();
    api.renderCardHighlights();
    assert.equal(calls, 1);
    complete({ ItemIds: ['1'] });
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(cards[0].classes.has('embySegmentFavoriteCard'));
    assert.ok(cards[0].classes.has('embySegmentSavedCard'));
    assert.ok(cards[1].classes.has('embySegmentSavedCard'));
    assert.equal(cards[2].classes.size, 0);
    api.renderCardHighlights();
    assert.equal(calls, 1);
    api.setHighlightMode('None');
    api.renderCardHighlights();
    assert.ok(cards.every(card => card.classes.size === 0));
});

test('a low numeric item ID keeps its segment border after browsing more than 512 cached videos', async () => {
    const requests = [];
    const items = Array.from({ length: 100 }, (_, index) => ({ Id: String(10000 + index), Type: 'Video' }));
    const { api, cards } = cardHarness('Segments', items, url => {
        const ids = url.split('=')[1].split(',');
        requests.push(ids);
        // Bound the old cache-eviction bug: it immediately requests the same
        // low ID again forever after dropping the successful response.
        if (requests.length > 7) return new Promise(() => {});
        return Promise.resolve({ ItemIds: ids.filter(id => id === '1') });
    });

    // Browse six pages through reused card nodes, filling exactly 512 entries
    // using real render/query cycles rather than reaching into cache internals.
    for (let start = 0; start < 512; start += 100) {
        for (let index = 0; index < items.length; index++) {
            cards[index].isConnected = start + index < 512;
            items[index].Id = String(10000 + start + index);
        }
        api.renderCardHighlights();
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(requests.length, 6);
    assert.equal(requests.flat().length, 512);

    items[0].Id = '1';
    cards.forEach((card, index) => { card.isConnected = index === 0; });
    api.renderCardHighlights();
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(cards[0].classes.has('embySegmentSavedCard'), 'the newly fetched low ID must survive cache eviction');
    assert.equal(requests.length, 7, 'the successful low-ID request must not immediately repeat');

    api.renderCardHighlights();
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(cards[0].classes.has('embySegmentSavedCard'));
    assert.equal(requests.length, 7, 'subsequent renders should reuse the newly cached status');
});

function fakeClock(context) {
    let now = 100000, sequence = 0;
    const timers = new Map();
    context.Date = class extends Date { static now() { return now; } };
    context.setTimeout = (callback, delay) => {
        const id = ++sequence;
        timers.set(id, { callback, at: now + delay });
        return id;
    };
    context.clearTimeout = id => timers.delete(id);
    context.AbortController = AbortController;
    return async milliseconds => {
        now += milliseconds;
        for (const [id, timer] of [...timers]) {
            if (timer.at <= now) { timers.delete(id); timer.callback(); }
        }
        await new Promise(resolve => setImmediate(resolve));
    };
}

test('a hung highlight request is aborted and retried without refreshing; its late result is ignored', async () => {
    let calls = 0, firstSignal, lateResult;
    const { api, cards, context } = cardHarness('Segments', [{ Id: '1', Type: 'Video' }], (url, signal) => {
        calls++;
        if (calls === 1) {
            firstSignal = signal;
            return new Promise(resolve => { lateResult = resolve; });
        }
        return Promise.resolve({ ItemIds: ['1'] });
    });
    const advance = fakeClock(context);
    api.renderCardHighlights();
    assert.equal(calls, 1);
    await advance(8000);
    assert.equal(firstSignal.aborted, true);
    await advance(3000);
    api.renderCardHighlights();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 2);
    assert.ok(cards[0].classes.has('embySegmentSavedCard'));
    lateResult({ ItemIds: [] });
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(cards[0].classes.has('embySegmentSavedCard'));
    assert.equal(calls, 2);
});

test('transient highlight failure preserves an existing border and retries promptly', async () => {
    let calls = 0;
    const { api, cards, context } = cardHarness('Segments', [{ Id: '1', Type: 'Video' }], async () => {
        if (++calls === 2) throw Error('temporary network failure');
        return { ItemIds: ['1'] };
    });
    const advance = fakeClock(context);
    api.renderCardHighlights();
    await new Promise(resolve => setImmediate(resolve));
    await advance(30000);
    api.renderCardHighlights();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 2);
    assert.ok(cards[0].classes.has('embySegmentSavedCard'));
    await advance(3000);
    api.renderCardHighlights();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 3);
    assert.ok(cards[0].classes.has('embySegmentSavedCard'));
});

test('a hung configuration request can recover without reloading the page', async () => {
    let calls = 0, lateResult, firstSignal;
    const { api, context } = harness({ getJSON: (url, signal) => {
        assert.equal(url, 'SegmentLoop/ClientConfiguration');
        if (++calls === 1) {
            firstSignal = signal;
            return new Promise(resolve => { lateResult = resolve; });
        }
        return Promise.resolve({ CardHighlightMode: 'Segments' });
    } });
    context.requestAnimationFrame = callback => callback();
    const advance = fakeClock(context);
    api.loadShortcutConfiguration();
    api.loadShortcutConfiguration();
    assert.equal(calls, 1);
    await advance(8000);
    assert.equal(firstSignal.aborted, true);
    await advance(3000);
    api.loadShortcutConfiguration();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 2);
    assert.equal(context.EmbySegmentLoopConfig.cardHighlightMode, 'Segments');
    lateResult({ CardHighlightMode: 'None' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(context.EmbySegmentLoopConfig.cardHighlightMode, 'Segments');
});

test('a page with more than 512 cards highlights every item without repeated request loops', async () => {
    let calls = 0;
    const items = Array.from({ length: 600 }, (_, i) => ({ Id: String(i + 1), Type: 'Video' }));
    const { api, cards } = cardHarness('Segments', items, url => {
        if (++calls > 6) return new Promise(() => {});
        return Promise.resolve({ ItemIds: url.split('=')[1].split(',') });
    });
    api.renderCardHighlights();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 6);
    assert.ok(cards.every(card => card.classes.has('embySegmentSavedCard')));
    api.renderCardHighlights();
    assert.equal(calls, 6);
});

test('recycled card nodes drop the previous movie border and segment-only mode excludes favorite border', async () => {
    const item = { Id: '1', Type: 'Movie', UserData: { IsFavorite: true } };
    const { api, cards } = cardHarness('Segments', [item], async url => ({ ItemIds: url.endsWith('=1') ? ['1'] : [] }));
    api.renderCardHighlights();
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(cards[0].classes.has('embySegmentSavedCard'));
    assert.ok(!cards[0].classes.has('embySegmentFavoriteCard'));
    item.Id = '2';
    api.renderCardHighlights();
    assert.equal(cards[0].classes.size, 0);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(cards[0].classes.size, 0);
});

test('scroll and card changes coalesce into the next frame and update recycled favorites', () => {
    const item = { Id: '1', Type: 'Video', UserData: { IsFavorite: true } };
    const { api, cards, context } = cardHarness('Favorites', [item], async () => ({}));
    const frames = [];
    context.requestAnimationFrame = callback => frames.push(callback);
    api.scheduleCardHighlights();
    api.scheduleCardHighlights();
    assert.equal(frames.length, 1);
    frames.shift()();
    assert.ok(cards[0].classes.has('embySegmentFavoriteCard'));
    item.Id = '2';
    item.UserData.IsFavorite = false;
    api.scheduleCardHighlights();
    frames.shift()();
    assert.equal(cards[0].classes.size, 0);
});

test('file sizes distinguish missing values from zero and use binary units', () => {
    const { api } = harness();
    assert.equal(api.formatFileSize(0), '0 B');
    assert.equal(api.formatFileSize(1024 ** 3), '1.00 GiB');
    for (const value of [null, undefined, '', -1, Infinity, 'invalid'])
        assert.equal(api.formatFileSize(value), '未知');
});

test('capture waits for existing server records and serializes quick consecutive saves', async () => {
    let completeLoad;
    const posted = [];
    const { api } = harness({
        getJSON: () => new Promise(resolve => { completeLoad = resolve; }),
        ajax: async request => { posted.push(JSON.parse(request.data)); return { Revision: 'r' + posted.length }; }
    });
    const record = id => ({ id, name: id, startMs: 1000, endMs: 2000, order: 1 });
    const a = api.saveSegment('1', record('new1'));
    const b = api.saveSegment('1', record('new2'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(posted.length, 0);
    completeLoad({ Segments: [{ Id: 'existing', Name: 'old', StartMs: 0, EndMs: 500, Order: 1 }], Revision: 'r0' });
    await Promise.all([a, b]);
    assert.deepEqual(posted[1].Segments.map(s => s.id), ['existing', 'new1', 'new2']);
    assert.equal(posted[0].ExpectedRevision, 'r0');
    assert.equal(posted[1].ExpectedRevision, 'r1');
});

test('failed load prevents destructive replacement and failed save keeps recoverable backup', async () => {
    let calls = 0;
    const record = { id: 'new', startMs: 0, endMs: 1000 };
    const first = harness({ getJSON: async () => { throw Error('offline'); }, ajax: async () => { calls++; } });
    assert.equal(await first.api.saveSegment('1', record), false);
    assert.equal(calls, 0);
    const second = harness({ ajax: async () => { throw { status: 409 }; } });
    assert.equal(await second.api.saveSegment('1', record), false);
    const state = JSON.parse(second.storage.get('embySegmentLoop.v1'));
    assert.equal(state.unsavedItems['1'][0].id, 'new');
});

test('pause is preserved; switching to another item clears an old loop', () => {
    const { api, video } = harness();
    api.rememberPlaybackItemId('1');
    api.setActive({ itemId: '1', source: 'video.mp4', segment: { startMs: 1000, endMs: 2000 } });
    video.paused = true;
    api.onVideoTimeUpdate();
    assert.equal(video.currentTime, 20);
    assert.equal(video.playCalls, 0);
    api.rememberPlaybackItemId('2');
    assert.equal(api.getActive(), null);
});

test('transcoded playback uses Emby absolute ticks for capture and seek', async () => {
    const { api, video } = harness();
    let ticks;
    api.setManager({ currentTime: () => 905000000, seek: value => { ticks = value; } });
    assert.equal(api.getPlaybackTimeMs(video), 90500);
    await api.seekVideo(video, 83000);
    assert.equal(ticks, 830000000);
});

test('detail metadata requests are shared and cached', async () => {
    let calls = 0;
    const { api } = harness({ getItem: async () => { calls++; return { MediaType: 'Video', Size: 1024 }; } });
    await Promise.all([api.getDetailItemInfo('1'), api.getDetailItemInfo('1')]);
    await api.getDetailItemInfo('1');
    assert.equal(calls, 1);
});

test('nonvideo detail pages do not repeatedly request video segment endpoints', async () => {
    let calls = 0;
    const { api } = harness({
        getItem: async () => ({ MediaType: 'Audio' }),
        getJSON: async () => { calls++; return { Segments: [], Revision: 'empty' }; }
    });
    const host = { isConnected: true, getAttribute: () => '1', hidden: false };
    api.fillDetailHost(host, '1');
    await new Promise(resolve => setImmediate(resolve));
    api.fillDetailHost(host, '1');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 0);
    assert.equal(host.hidden, true);
});

test('detail row follows selected media source and skips stale navigation results', async () => {
    let itemId = '1';
    const host = { dataset: {}, isConnected: true, textContent: '', hidden: true };
    const select = { value: 'large' };
    const { api, context } = harness({ getItem: async () => ({ MediaType: 'Video', MediaSources: [
        { Id: 'small', Size: 1024 }, { Id: 'large', Size: 1024 ** 3, Container: 'mkv' }
    ] }) });
    const buttons = { parentNode: { querySelector: () => host }, closest: () => ({ querySelector: () => select }) };
    context.location.href = 'http://localhost/web/index.html#!/item?id=1';
    api.renderDetailInfo(buttons, itemId);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(host.textContent, '文件大小：1.00 GiB · MKV');
    select.value = 'small';
    api.renderDetailInfo(buttons, itemId);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(host.textContent, '文件大小：1.00 KiB');
    context.location.href = 'http://localhost/web/index.html#!/item?id=2';
    select.value = 'large';
    api.renderDetailInfo(buttons, itemId);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(host.textContent, '文件大小：1.00 KiB');
});
