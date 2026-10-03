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
        window.testApi = { parseTime, formatFileSize, getDetailItemInfo, renderDetailInfo, fillDetailHost, saveSegment, getItemSegments,
            ensureItemLoaded, onVideoTimeUpdate, rememberPlaybackItemId, getPlaybackTimeMs, seekVideo,
            renderCardHighlights, scheduleCardHighlights,
            setHighlightMode: value => { shortcutConfigurationLoaded = true; window.EmbySegmentLoopConfig = { cardHighlightMode: value }; },
            setActive: value => { activeSegment = value; }, getActive: () => activeSegment,
            setManager: value => { resolvedPlaybackManager = value; } };
    }());`, context);
    return { api: context.testApi, video, storage, context };
}

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
