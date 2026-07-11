(function () {
    'use strict';

    var storageKey = 'embySegmentLoop.v1';
    var pendingKey = 'embySegmentLoop.pending';
    var pluginId = '8c1e7ca2-3f07-4b62-a4d1-929f07509367';
    var rememberedItemKey = 'embySegmentLoop.currentItem';
    var activeSegment = null;
    var markStartMs = null;
    var currentPlaybackItemId = null;
    var playbackManagerPromise = null;
    var isRendering = false;
    var renderTimer = null;
    var segmentLaunchInProgress = false;
    var playbackRenderGeneration = 0;
    var loadedServerItems = {};
    var loadingServerItems = {};
    var itemSegmentCache = {};

    function loadState() {
        try {
            return JSON.parse(localStorage.getItem(storageKey)) || defaultState();
        } catch (err) {
            return defaultState();
        }
    }

    function defaultState() {
        return {
            items: {}
        };
    }

    function saveState(state) {
        localStorage.setItem(storageKey, JSON.stringify(state));
    }

    function getState() {
        var state = loadState();
        state.items = state.items || {};
        return state;
    }

    function getShortcutSettings() {
        var config = window.EmbySegmentLoopConfig || {};
        return {
            startKey: config.startKey || '[',
            endKey: config.endKey || ']'
        };
    }

    function getItemSegments(itemId) {
        if (!itemId) {
            return [];
        }
        if (Object.prototype.hasOwnProperty.call(itemSegmentCache, itemId)) {
            return sortSegments(itemSegmentCache[itemId]);
        }
        return sortSegments(getState().items[itemId] || []);
    }

    function setItemSegments(itemId, segments) {
        var normalized = sortSegments(segments).map(function (segment, index) {
            var copy = Object.assign({}, segment, { order: index + 1 });
            if (/^片段\s*\d+$/.test(copy.name || '')) {
                copy.name = '片段 ' + (index + 1);
            }
            return copy;
        });
        itemSegmentCache[itemId] = normalized;
        persistItemSegments(itemId, normalized).then(function (saved) {
            if (saved) {
                removeLegacyItem(itemId);
            } else {
                var state = getState();
                state.items[itemId] = normalized;
                saveState(state);
            }
        });
    }

    function removeLegacyItem(itemId) {
        var state = getState();
        if (Object.prototype.hasOwnProperty.call(state.items, itemId)) {
            delete state.items[itemId];
            saveState(state);
        }
    }

    function normalizeServerSegment(segment, index) {
        return {
            id: segment.id || segment.Id || String(Date.now() + index),
            name: segment.name || segment.Name || '',
            startMs: Number(segment.startMs != null ? segment.startMs : segment.StartMs) || 0,
            endMs: Number(segment.endMs != null ? segment.endMs : segment.EndMs) || 0,
            order: Number(segment.order != null ? segment.order : segment.Order) || index + 1
        };
    }

    function segmentApiUrl(itemId) {
        return window.ApiClient && ApiClient.getUrl('SegmentLoop/Segments/' + encodeURIComponent(itemId));
    }

    function persistItemSegments(itemId, segments) {
        var url = segmentApiUrl(itemId);
        if (!url) return Promise.resolve(false);
        return ApiClient.ajax({
            type: 'POST',
            url: url,
            contentType: 'application/json',
            data: JSON.stringify({ ItemId: itemId, Segments: segments })
        }).then(function () {
            return true;
        }).catch(function (error) {
            console.error('Segment Loop: failed to save segments', error);
            showToast('片段数据库保存失败，已保留浏览器副本');
            return false;
        });
    }

    function ensureItemLoaded(itemId) {
        if (!itemId || loadedServerItems[itemId]) return Promise.resolve();
        if (loadingServerItems[itemId]) return loadingServerItems[itemId];
        var url = segmentApiUrl(itemId);
        if (!url) return Promise.resolve();
        var localSegments = getItemSegments(itemId);
        loadingServerItems[itemId] = ApiClient.getJSON(url).then(function (serverSegments) {
            serverSegments = (Array.isArray(serverSegments) ? serverSegments : []).map(normalizeServerSegment);
            if (serverSegments.length) {
                itemSegmentCache[itemId] = sortSegments(serverSegments);
                removeLegacyItem(itemId);
            } else if (localSegments.length) {
                // One-time transparent migration from the previous localStorage
                // implementation. The local copy remains as an offline cache.
                itemSegmentCache[itemId] = localSegments;
                return persistItemSegments(itemId, localSegments).then(function (saved) {
                    if (saved) removeLegacyItem(itemId);
                });
            } else {
                itemSegmentCache[itemId] = [];
            }
        }).then(function () {
            loadedServerItems[itemId] = true;
            delete loadingServerItems[itemId];
            renderAll();
        }).catch(function (error) {
            delete loadingServerItems[itemId];
            console.error('Segment Loop: failed to load segments', error);
        });
        return loadingServerItems[itemId];
    }

    function getSegmentNumber(segment) {
        var match = String(segment.name || '').match(/\d+/);
        return match ? Number(match[0]) : NaN;
    }

    function getSegmentOrder(segment, index) {
        var order = Number(segment.order);
        if (isFinite(order) && order > 0) {
            return order;
        }
        order = getSegmentNumber(segment);
        return isFinite(order) && order > 0 ? order : index + 1;
    }

    function sortSegments(segments) {
        return cloneSegments(segments).sort(function (a, b) {
            return getSegmentOrder(a, 0) - getSegmentOrder(b, 0) || Number(a.id) - Number(b.id);
        });
    }

    function getNextSegmentOrder(itemId) {
        return getItemSegments(itemId).reduce(function (max, segment, index) {
            return Math.max(max, getSegmentOrder(segment, index));
        }, 0) + 1;
    }

    function rememberPlaybackItemId(itemId) {
        if (!itemId) {
            return;
        }
        currentPlaybackItemId = itemId;
        localStorage.setItem(rememberedItemKey, JSON.stringify({ itemId: itemId, time: Date.now() }));
    }

    function getRememberedPlaybackItemId() {
        if (currentPlaybackItemId) {
            return currentPlaybackItemId;
        }
        try {
            var remembered = JSON.parse(localStorage.getItem(rememberedItemKey));
            if (remembered && remembered.itemId && Date.now() - remembered.time < 300000) {
                currentPlaybackItemId = remembered.itemId;
                return currentPlaybackItemId;
            }
        } catch (err) {}
        return null;
    }

    function getUrlItemId() {
        var text = location.href;
        var match = text.match(/[?&#](?:id|itemid|itemId)=([^&#]+)/);
        return match ? decodeURIComponent(match[1]) : null;
    }

    function isRendered(element) {
        if (!element || !element.isConnected || !element.getClientRects().length) {
            return false;
        }
        for (var node = element; node && node !== document.body; node = node.parentElement) {
            if (node.hidden || node.getAttribute('aria-hidden') === 'true' || node.classList.contains('hide')) {
                return false;
            }
        }
        return true;
    }

    function getVideo() {
        var videos = Array.prototype.slice.call(document.querySelectorAll('video')).filter(function (video) {
            return isRendered(video) && (video.src || video.currentSrc || video.readyState > 0);
        });
        // Emby can retain the previous player and alternate between player views.
        // Prefer the visible video that is actually playing, then the newest
        // visible candidate instead of blindly selecting the first DOM node.
        return videos.filter(function (video) { return !video.paused && !video.ended; }).pop() || videos.pop() || null;
    }

    function getPlaybackManager() {
        if (!playbackManagerPromise) {
            if (window.Emby && Emby.importModule) {
                playbackManagerPromise = Emby.importModule('playbackManager').then(function (module) {
                    return module.default || module;
                }).catch(function () {
                    return Emby.importModule('./modules/common/playback/playbackmanager.js').then(function (module) {
                        return module.default || module;
                    });
                }).catch(function () {
                    return null;
                });
            } else if (window.require) {
                playbackManagerPromise = new Promise(function (resolve) {
                    require(['playbackManager'], function (module) {
                        resolve(module.default || module);
                    }, function () {
                        resolve(null);
                    });
                });
            } else {
                return Promise.resolve(null);
            }
        }
        return playbackManagerPromise.then(function (playbackManager) {
            // The loader can run before Emby's module system is ready. Do not cache
            // that transient failure forever; the periodic renderer will retry.
            if (!playbackManager) {
                playbackManagerPromise = null;
            }
            return playbackManager;
        }, function () {
            playbackManagerPromise = null;
            return null;
        });
    }

    function getCurrentPlaybackItem() {
        return getPlaybackManager().then(function (playbackManager) {
            if (!playbackManager) {
                return null;
            }
            if (playbackManager.currentItem) {
                try {
                    var currentItem = playbackManager.currentItem();
                    if (currentItem && currentItem.Id) {
                        return currentItem;
                    }
                } catch (err) {}
            }
            if (!playbackManager.getPlayerState) {
                return null;
            }
            var state;
            try {
                state = playbackManager.getPlayerState();
            } catch (err) {
                return null;
            }
            return state && state.NowPlayingItem ? state.NowPlayingItem : null;
        });
    }

    function formatTime(ms) {
        ms = Math.max(0, Math.round(Number(ms) || 0));
        var h = Math.floor(ms / 3600000);
        var m = Math.floor(ms % 3600000 / 60000);
        var s = Math.floor(ms % 60000 / 1000);
        var x = ms % 1000;
        return (h ? h + ':' : '') + String(m).padStart(h ? 2 : 1, '0') + ':' + String(s).padStart(2, '0') + '.' + String(x).padStart(3, '0');
    }

    function parseTime(value) {
        value = String(value || '').trim();
        if (!value) {
            return NaN;
        }
        if (/^\d+(?:\.\d+)?$/.test(value)) {
            return Math.round(Number(value) * 1000);
        }
        var parts = value.split(':');
        var seconds = Number(parts.pop());
        var minutes = parts.length ? Number(parts.pop()) : 0;
        var hours = parts.length ? Number(parts.pop()) : 0;
        if ([seconds, minutes, hours].some(function (n) { return !isFinite(n); })) {
            return NaN;
        }
        return Math.round(((hours * 60 + minutes) * 60 + seconds) * 1000);
    }

    function segmentLabel(segment) {
        return segment.name + '  ' + formatTime(segment.startMs) + '-' + formatTime(segment.endMs);
    }

    function cloneSegments(segments) {
        return (Array.isArray(segments) ? segments : []).map(function (segment, index) {
            return {
                id: segment.id || String(Date.now() + Math.random()),
                name: segment.name || '',
                startMs: Number(segment.startMs) || 0,
                endMs: Number(segment.endMs) || 0,
                order: Number(segment.order) || getSegmentNumber(segment) || index + 1
            };
        });
    }

    function saveSegment(itemId, segment) {
        var segments = getItemSegments(itemId).slice();
        var exists = segments.some(function (item) { return item.id === segment.id; });
        if (exists) {
            segments = segments.map(function (item) { return item.id === segment.id ? segment : item; });
        } else {
            segments.push(segment);
        }
        setItemSegments(itemId, segments);
        renderAll();
    }

    function showToast(message) {
        var toast = document.createElement('div');
        toast.className = 'embySegmentToast';
        toast.textContent = message;
        document.body.appendChild(toast);
        setTimeout(function () {
            toast.remove();
        }, 1800);
    }

    function openEditor(itemId, selectedSegment) {
        if (!itemId) {
            showToast('无法识别视频');
            return;
        }
        closeEditor();
        var originalSegments = cloneSegments(getItemSegments(itemId));
        var editingSingle = !!selectedSegment;
        var segments = editingSingle ? cloneSegments([selectedSegment]) : originalSegments.slice();
        var overlay = document.createElement('div');
        overlay.className = 'embySegmentDialogOverlay';
        overlay.innerHTML = '<div class="embySegmentDialog"><div class="embySegmentDialogHeader"><h2>片段编辑</h2><button type="button" class="embySegmentDialogClose" title="取消">&#xe5cd;</button></div><div class="embySegmentDialogBody"><div class="embySegmentHelp">时间支持秒或 HH:MM:SS.mmm，例如 83.250 或 0:01:23.250。快捷键请在 Emby 插件设置中修改。</div><div class="embySegmentEditorRows"></div><button type="button" class="embySegmentEditorAdd raised">+ 新建片段</button></div><div class="embySegmentDialogFooter"><button type="button" class="embySegmentCancel raised cancel">取消</button><button type="button" class="embySegmentSave raised submit">保存</button></div></div>';
        document.body.appendChild(overlay);

        function renderRows() {
            var rows = overlay.querySelector('.embySegmentEditorRows');
            rows.innerHTML = '';
            segments.forEach(function (segment, index) {
                var row = document.createElement('div');
                row.className = 'embySegmentEditorRow';
                row.dataset.index = String(index);
                row.innerHTML = '<label><span>名称</span><input class="embySegmentName" value=""></label><label><span>开始</span><input class="embySegmentStart" value=""></label><label><span>结束</span><input class="embySegmentEnd" value=""></label><button type="button" class="embySegmentDelete" title="删除">&#xe872;</button>';
                row.querySelector('.embySegmentName').value = segment.name || ('片段 ' + (index + 1));
                row.querySelector('.embySegmentStart').value = formatTime(segment.startMs);
                row.querySelector('.embySegmentEnd').value = formatTime(segment.endMs);
                row.querySelector('.embySegmentDelete').onclick = function () {
                    segments.splice(index, 1);
                    renderRows();
                };
                rows.appendChild(row);
            });
        }

        var addButton = overlay.querySelector('.embySegmentEditorAdd');
        if (editingSingle) {
            addButton.classList.add('hide');
        }
        addButton.onclick = function () {
            var order = segments.reduce(function (max, segment, index) {
                return Math.max(max, getSegmentOrder(segment, index));
            }, 0) + 1;
            segments.push({
                id: String(Date.now() + Math.random()),
                name: '片段 ' + order,
                startMs: 0,
                endMs: 10000,
                order: order
            });
            renderRows();
        };
        overlay.querySelector('.embySegmentSave').onclick = function () {
            var newSegments = editingSingle ? originalSegments.filter(function (segment) {
                return segment.id !== selectedSegment.id;
            }) : [];
            var invalid = false;
            Array.prototype.slice.call(overlay.querySelectorAll('.embySegmentEditorRow')).forEach(function (row, index) {
                var startMs = parseTime(row.querySelector('.embySegmentStart').value);
                var endMs = parseTime(row.querySelector('.embySegmentEnd').value);
                if (!isFinite(startMs) || !isFinite(endMs) || endMs <= startMs) {
                    invalid = true;
                    row.classList.add('embySegmentInvalid');
                    return;
                }
                newSegments.push({
                    id: segments[index].id || String(Date.now() + index),
                    name: row.querySelector('.embySegmentName').value.trim() || ('片段 ' + (index + 1)),
                    startMs: startMs,
                    endMs: endMs,
                    order: getSegmentOrder(segments[index], index)
                });
            });
            if (invalid) {
                showToast('请修正无效片段时间');
                return;
            }
            setItemSegments(itemId, newSegments);
            closeEditor();
            renderAll();
            showToast('片段设置已保存');
        };
        overlay.querySelector('.embySegmentCancel').onclick = closeEditor;
        overlay.querySelector('.embySegmentDialogClose').onclick = closeEditor;
        overlay.onclick = function (e) {
            if (e.target === overlay) {
                closeEditor();
            }
        };
        renderRows();
    }

    function closeEditor() {
        var overlay = document.querySelector('.embySegmentDialogOverlay');
        if (overlay) {
            overlay.remove();
        }
    }

    function playSegmentFromDetail(itemId, segment) {
        activeSegment = null;
        localStorage.setItem(pendingKey, JSON.stringify({ itemId: itemId, segmentId: segment.id, time: Date.now() }));
        var video = getVideo();
        if (video) {
            activateSegment(itemId, segment);
            return;
        }
        var playButton = document.querySelector('.btnResume:not(.hide), .btnMainPlay:not(.hide), .btnPlay:not(.hide)');
        if (playButton) {
            segmentLaunchInProgress = true;
            playButton.click();
            setTimeout(function () {
                segmentLaunchInProgress = false;
            }, 1000);
        } else {
            showToast('未找到播放按钮');
        }
    }

    function activateSegment(itemId, segment) {
        var video = getVideo();
        if (!video) {
            return;
        }
        if (activeSegment && activeSegment.itemId === itemId && activeSegment.segment.id === segment.id) {
            activeSegment = null;
            renderOsdSegments(itemId);
            showToast('已取消片段循环');
            return;
        }
        rememberPlaybackItemId(itemId);
        activeSegment = { itemId: itemId, segment: segment };
        seekVideo(video, segment.startMs);
        video.play().catch(function () {});
        renderOsdSegments(itemId);
        showToast('循环播放：' + segment.name);
    }

    function seekVideo(video, ms) {
        var seconds = Math.max(0, ms / 1000);
        try {
            if (video.fastSeek) {
                video.fastSeek(seconds);
            } else {
                video.currentTime = seconds;
            }
        } catch (err) {
            video.currentTime = seconds;
        }
    }

    function onVideoTimeUpdate() {
        if (!activeSegment) {
            return;
        }
        var video = getVideo();
        if (!video) {
            return;
        }
        var currentMs = video.currentTime * 1000;
        if (currentMs < activeSegment.segment.startMs - 500 || currentMs >= activeSegment.segment.endMs) {
            seekVideo(video, activeSegment.segment.startMs);
            video.play().catch(function () {});
        }
    }

    function ensureVideoHook() {
        var video = getVideo();
        if (video && !video.embySegmentLoopHooked) {
            video.embySegmentLoopHooked = true;
            video.addEventListener('timeupdate', onVideoTimeUpdate);
            video.addEventListener('ended', onVideoTimeUpdate);
        }
    }

    function renderDetailSegments() {
        var buttons = document.querySelector('.mainDetailButtons');
        if (!buttons) {
            return;
        }
        var itemId = getUrlItemId();
        if (!itemId) {
            return;
        }
        ensureItemLoaded(itemId);
        var host = document.querySelector('.embySegmentDetailList');
        if (!host) {
            host = document.createElement('div');
            host.className = 'embySegmentDetailList verticalFieldItem detail-lineItem';
            buttons.parentNode.insertBefore(host, buttons.nextSibling);
        }
        var segments = getItemSegments(itemId);
        host.innerHTML = '<div class="embySegmentTitle">循环片段</div>';
        var rows = document.createElement('div');
        rows.className = 'embySegmentRows focuscontainer-x';
        segments.forEach(function (segment) {
            var wrap = document.createElement('span');
            wrap.className = 'embySegmentChipWrap';
            var button = document.createElement('button');
            button.type = 'button';
            button.className = 'embySegmentChip raised';
            button.textContent = segment.name || '未命名片段';
            button.title = segmentLabel(segment);
            button.onclick = function () { playSegmentFromDetail(itemId, segment); };
            var edit = document.createElement('button');
            edit.type = 'button';
            edit.className = 'embySegmentGear paper-icon-button-light';
            edit.title = '编辑片段';
            edit.setAttribute('aria-label', '编辑片段');
            edit.innerHTML = '<i class="md-icon">more_horiz</i>';
            edit.onclick = function () { openEditor(itemId, segment); };
            wrap.appendChild(button);
            wrap.appendChild(edit);
            rows.appendChild(wrap);
        });
        var add = document.createElement('button');
        add.type = 'button';
        add.className = 'embySegmentAdd raised';
        add.textContent = '编辑片段';
        add.onclick = function () { openEditor(itemId); };
        rows.appendChild(add);
        host.appendChild(rows);
    }

    function renderOsdSegments(itemId) {
        var positions = Array.prototype.slice.call(document.querySelectorAll('.videoOsdPositionContainer')).filter(isRendered);
        var position = positions.pop();
        if (!position || !itemId) {
            return;
        }
        var parent = position.parentNode;
        if (!parent) {
            return;
        }
        var host = parent.querySelector('.embySegmentOsdList');
        if (!host) {
            host = document.createElement('div');
            host.className = 'embySegmentOsdList videoOsd-hideWithOpenTab videoOsd-hideWhenLocked focuscontainer-x';
        }
        Array.prototype.slice.call(document.querySelectorAll('.embySegmentOsdList')).forEach(function (otherHost) {
            if (otherHost !== host) {
                otherHost.remove();
            }
        });
        if (host.parentNode !== parent || host.previousElementSibling !== position) {
            parent.insertBefore(host, position.nextSibling);
        }
        host.dataset.itemId = String(itemId);

        // Event delegation – registered once per host
        if (!host.dataset.segLoopDelegated) {
            host.dataset.segLoopDelegated = '1';
            host.addEventListener('click', function (e) {
                var chip = e.target.closest('.embySegmentOsdChip');
                if (!chip || !chip.dataset.segmentId) return;
                var currentItemId = host.dataset.itemId;
                if (!currentItemId) return;
                var segment = getItemSegments(currentItemId).filter(function (s) { return s.id === chip.dataset.segmentId; })[0];
                if (segment) activateSegment(currentItemId, segment);
            });
        }

        // Incremental update – keep existing DOM buttons, only add/remove/update
        var segments = getItemSegments(itemId);
        var existing = {};
        Array.prototype.slice.call(host.querySelectorAll('.embySegmentOsdChip')).forEach(function (btn) {
            existing[btn.dataset.segmentId] = btn;
        });
        var wanted = {};
        segments.forEach(function (segment) {
            wanted[segment.id] = true;
            var btn = existing[segment.id];
            if (!btn) {
                btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'embySegmentOsdChip';
                btn.dataset.segmentId = segment.id;
                host.appendChild(btn);
            }
            btn.textContent = segment.name;
            btn.title = segmentLabel(segment);
            var isActive = activeSegment && activeSegment.itemId === itemId && activeSegment.segment.id === segment.id;
            if (isActive) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });
        Object.keys(existing).forEach(function (id) {
            if (!wanted[id]) existing[id].remove();
        });
    }

    function tryPendingSegment(itemId) {
        if (!itemId) {
            return;
        }
        var pending;
        try {
            pending = JSON.parse(localStorage.getItem(pendingKey));
        } catch (err) {
            pending = null;
        }
        if (!pending || pending.itemId !== itemId || Date.now() - pending.time > 60000) {
            return;
        }
        var segment = getItemSegments(itemId).filter(function (item) { return item.id === pending.segmentId; })[0];
        if (segment) {
            localStorage.removeItem(pendingKey);
            activateSegment(itemId, segment);
        }
    }

    function tryAnyPendingSegment() {
        var pending;
        try {
            pending = JSON.parse(localStorage.getItem(pendingKey));
        } catch (err) {
            pending = null;
        }
        if (!pending || Date.now() - pending.time > 60000) {
            return;
        }
        tryPendingSegment(pending.itemId);
    }

    function renderPlaybackSegments() {
        var generation = ++playbackRenderGeneration;
        ensureVideoHook();
        if (!getVideo()) {
            activeSegment = null;
            markStartMs = null;
            currentPlaybackItemId = null;
            Array.prototype.slice.call(document.querySelectorAll('.embySegmentOsdList')).forEach(function (host) {
                host.remove();
            });
            return;
        }
        tryAnyPendingSegment();
        getCurrentPlaybackItem().then(function (item) {
            if (generation !== playbackRenderGeneration || !getVideo()) {
                return;
            }
            var itemId = item && item.Id;
            if (!itemId) {
                var pending;
                try {
                    pending = JSON.parse(localStorage.getItem(pendingKey));
                } catch (err) {
                    pending = null;
                }
                // A pending segment is tied to an explicit click and is therefore
                // safer than the remembered detail-page id. The latter is only a
                // short-lived fallback while playbackManager is still initializing.
                var rememberedItemId = pending && pending.itemId || getRememberedPlaybackItemId();
                if (rememberedItemId) {
                    renderOsdSegments(rememberedItemId);
                    tryPendingSegment(rememberedItemId);
                }
                return;
            }
            rememberPlaybackItemId(itemId);
            ensureItemLoaded(itemId);
            renderOsdSegments(itemId);
            tryPendingSegment(itemId);
        });
    }

    function onKeyDown(e) {
        var target = e.target;
        if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) {
            return;
        }
        var video = getVideo();
        if (!video) {
            return;
        }
        var settings = getShortcutSettings();
        if (e.key !== settings.startKey && e.key !== settings.endKey) {
            return;
        }
        e.preventDefault();
        getCurrentPlaybackItem().then(function (item) {
            var itemId = item && item.Id || getRememberedPlaybackItemId() || (activeSegment && activeSegment.itemId);
            if (!itemId) {
                showToast('无法识别当前视频');
                return;
            }
            rememberPlaybackItemId(itemId);
            var currentMs = Math.round(video.currentTime * 1000);
            if (e.key === settings.startKey) {
                markStartMs = currentMs;
                showToast('片段开始：' + formatTime(markStartMs));
                return;
            }
            if (markStartMs === null) {
                showToast('请先按开始快捷键：' + settings.startKey);
                return;
            }
            var startMs = Math.min(markStartMs, currentMs);
            var endMs = Math.max(markStartMs, currentMs);
            markStartMs = null;
            if (endMs <= startMs) {
                showToast('片段长度无效');
                return;
            }
            var order = getNextSegmentOrder(itemId);
            saveSegment(itemId, {
                id: String(Date.now()),
                name: '片段 ' + order,
                startMs: startMs,
                endMs: endMs,
                order: order
            });
            showToast('已保存片段，可在设置中编辑名称和时间');
        });
    }

    function onDocumentClick(e) {
        var playButton = e.target && e.target.closest && e.target.closest('.btnResume, .btnMainPlay, .btnPlay');
        if (!playButton || playButton.closest('.embySegmentDetailList') || segmentLaunchInProgress) {
            return;
        }
        activeSegment = null;
        markStartMs = null;
        rememberPlaybackItemId(getUrlItemId() || currentPlaybackItemId);
        localStorage.removeItem(pendingKey);
    }

    function injectStyle() {
        if (document.getElementById('embySegmentLoopStyle')) {
            return;
        }
        var style = document.createElement('style');
        style.id = 'embySegmentLoopStyle';
        style.textContent = '.embySegmentDetailList{margin-top:.7em}.embySegmentTitle{font-weight:600;margin-bottom:.35em}.embySegmentRows{display:flex;gap:.45em;flex-wrap:wrap;align-items:center}.embySegmentChipWrap{display:inline-flex;align-items:center;border-radius:999px;background:rgba(255,255,255,.12);overflow:hidden}.embySegmentChip,.embySegmentAdd,.embySegmentSettings,.embySegmentGear,.embySegmentOsdChip{border:0;color:inherit;background:rgba(255,255,255,.16);border-radius:999px;padding:.55em .9em;cursor:pointer}.embySegmentDelete,.embySegmentDialogClose{font-family:Material Icons,Material Icons Round,Arial}.embySegmentGear{font-size:.9em;border-radius:0;padding:.55em .8em;background:rgba(255,255,255,.08)}.embySegmentChip{border-radius:999px 0 0 999px;background:transparent}.embySegmentAdd,.embySegmentSettings,.embySegmentSave{background:#43a047;color:#fff}.embySegmentOsdList{display:flex;gap:.4em;flex-wrap:wrap;justify-content:center;margin:.25em 0 .55em}.embySegmentOsdChip{font-size:.9em;background:rgba(0,0,0,.45);backdrop-filter:blur(8px)}.embySegmentOsdChip.active{background:#43a047;color:#fff}.embySegmentToast{position:fixed;left:50%;bottom:12%;transform:translateX(-50%);z-index:999999;background:rgba(0,0,0,.84);color:#fff;border-radius:999px;padding:.75em 1.1em;font-weight:600;box-shadow:0 6px 24px rgba(0,0,0,.35)}.embySegmentDialogOverlay{position:fixed;inset:0;z-index:999998;background:rgba(0,0,0,.58);display:flex;align-items:center;justify-content:center;padding:2rem}.embySegmentDialog{width:min(920px,96vw);max-height:92vh;display:flex;flex-direction:column;background:#202020;color:#fff;border-radius:.35rem;box-shadow:0 18px 55px rgba(0,0,0,.55);overflow:hidden}.embySegmentDialogHeader,.embySegmentDialogFooter{display:flex;align-items:center;padding:1.1rem 1.4rem;background:#262626}.embySegmentDialogHeader{justify-content:space-between}.embySegmentDialogHeader h2{font-size:1.45rem;margin:0;font-weight:500}.embySegmentDialogClose,.embySegmentDelete{border:0;background:transparent;color:inherit;cursor:pointer}.embySegmentDialogClose{font-size:28px}.embySegmentDialogBody{padding:1.2rem 1.4rem;overflow:auto}.embySegmentDialogFooter{justify-content:flex-end;gap:.7rem}.embySegmentFieldGrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem;margin-bottom:.7rem}.embySegmentFieldGrid label,.embySegmentEditorRow label{display:flex;flex-direction:column;gap:.35rem;color:rgba(255,255,255,.72);font-size:.88rem}.embySegmentFieldGrid input,.embySegmentEditorRow input{box-sizing:border-box;width:100%;background:#151515;color:#fff;border:1px solid rgba(255,255,255,.22);border-radius:.25rem;padding:.7rem .75rem;font:inherit}.embySegmentFieldGrid input:focus,.embySegmentEditorRow input:focus{outline:0;border-color:#43a047}.embySegmentHelp{color:rgba(255,255,255,.62);font-size:.9rem;margin:.25rem 0 1rem}.embySegmentEditorRows{display:flex;flex-direction:column;gap:.65rem;margin-bottom:1rem}.embySegmentEditorRow{display:grid;grid-template-columns:2fr 1fr 1fr auto;gap:.75rem;align-items:end;padding:.85rem;background:rgba(255,255,255,.06);border-radius:.35rem;border:1px solid transparent}.embySegmentEditorRow.embySegmentInvalid{border-color:#d32f2f}.embySegmentDelete{font-size:24px;height:2.7rem;width:2.7rem;border-radius:50%;background:rgba(255,255,255,.08)}.embySegmentEditorAdd,.embySegmentCancel,.embySegmentSave{border:0;border-radius:.25rem;padding:.65rem 1rem;color:inherit;cursor:pointer}.embySegmentCancel{background:rgba(255,255,255,.12)}@media(max-width:700px){.embySegmentDialogOverlay{padding:.75rem}.embySegmentFieldGrid,.embySegmentEditorRow{grid-template-columns:1fr}.embySegmentSettings{width:100%}.embySegmentChip{max-width:70vw;overflow:hidden;text-overflow:ellipsis}}';
        style.textContent += '.embySegmentOsdList{position:relative;z-index:2;pointer-events:auto}.embySegmentOsdChip{pointer-events:auto;touch-action:manipulation}';
        document.head.appendChild(style);
    }

    function openPluginSettingsDialog() {
        var old = document.querySelector('.embySegPluginSettingsOverlay');
        if (old) { old.remove(); }
        var overlay = document.createElement('div');
        overlay.className = 'embySegmentDialogOverlay embySegPluginSettingsOverlay';
        overlay.innerHTML = '<div class="embySegmentDialog"><div class="embySegmentDialogHeader"><h2>\u5feb\u6377\u952e\u8bbe\u7f6e</h2><button type="button" class="embySegmentDialogClose" title="\u5173\u95ed">&#xe5cd;</button></div><div class="embySegmentDialogBody"><div class="embySegPluginField"><label class="embySegPluginLabel">\u5f00\u59cb\u5feb\u6377\u952e</label><input class="embySegPluginInput" id="slgStart" type="text" placeholder="["><div class="embySegPluginDesc">\u9ed8\u8ba4 [\u3002\u586b\u5199 KeyboardEvent.key \u7684\u503c\u3002</div></div><div class="embySegPluginField"><label class="embySegPluginLabel">\u7ed3\u675f\u5feb\u6377\u952e</label><input class="embySegPluginInput" id="slgEnd" type="text" placeholder="]"><div class="embySegPluginDesc">\u9ed8\u8ba4 ]\u3002\u4fdd\u5b58\u540e\u5237\u65b0 Web \u9875\u9762\u751f\u6548\u3002</div></div><div class="embySegPluginField"><label class="embySegPluginLabel">\u7247\u6bb5\u6570\u636e\u5e93\u8def\u5f84</label><input class="embySegPluginInput" id="slgPath" type="text" placeholder="\u7559\u7a7a\u4f7f\u7528\u9ed8\u8ba4\u8def\u5f84"><div class="embySegPluginDesc">\u7559\u7a7a\u65f6\u4fdd\u5b58\u5230 programdata/metadata/segmentloop/segments.db\u3002</div></div></div><div class="embySegmentDialogFooter"><button type="button" class="embySegmentCancel raised">\u53d6\u6d88</button><button type="button" class="embySegmentSave raised">\u4fdd\u5b58</button></div></div>';
        document.body.appendChild(overlay);
        if (typeof ApiClient !== 'undefined') {
            ApiClient.getPluginConfiguration(pluginId).then(function (cfg) {
                var s = document.getElementById('slgStart'), e = document.getElementById('slgEnd'), p = document.getElementById('slgPath');
                if (s) s.value = cfg.StartKey || '[';
                if (e) e.value = cfg.EndKey || ']';
                if (p && cfg.StoragePath != null) p.value = cfg.StoragePath;
            });
        }
        var closeDialog = function () { overlay.remove(); };
        overlay.querySelector('.embySegmentDialogClose').onclick = closeDialog;
        overlay.querySelector('.embySegmentCancel').onclick = closeDialog;
        overlay.onclick = function (e) { if (e.target === overlay) closeDialog(); };
        overlay.querySelector('.embySegmentSave').onclick = function () {
            var s = document.getElementById('slgStart'), e = document.getElementById('slgEnd'), p = document.getElementById('slgPath');
            var sk = s && s.value || '[', ek = e && e.value || ']', pt = p && p.value || '';
            if (typeof ApiClient === 'undefined') { closeDialog(); return; }
            ApiClient.getPluginConfiguration(pluginId).then(function (cfg) {
                cfg.StartKey = sk; cfg.EndKey = ek; cfg.StoragePath = pt;
                return ApiClient.updatePluginConfiguration(pluginId, cfg);
            }).then(function () {
                closeDialog();
                showToast('\u5df2\u4fdd\u5b58\uff0c\u8bf7\u5237\u65b0\u9875\u9762\u8ba9\u5feb\u6377\u952e\u914d\u7f6e\u751f\u6548');
            });
        };
    }

    function renderSettingsItem() {
        var routes = document.querySelector('.dynamicRoutes');
        if (!routes || !routes.children.length) { return; }
        if (routes.querySelector('.embySegLoopSettingsItem')) { return; }
        var item = document.createElement('a');
        item.className = 'navMenuOption navMenuOption-settings embySegLoopSettingsItem';
        item.href = 'javascript:void(0)';
        item.innerHTML =
            '<div class="settingsMenuListItemBody settingsMenuListItemBody-extrapadding">' +
            '<i class="md-icon navMenuOption-icon" style="font-family:Material Icons,Arial">&#xe227;</i>' +
            '<div class="navMenuOption-text">Segment Loop</div>' +
            '</div>';
        item.onclick = function (e) { e.preventDefault(); openPluginSettingsDialog(); };
        routes.appendChild(item);
    }

    function renderAll() {
        isRendering = true;
        injectStyle();
        renderDetailSegments();
        renderPlaybackSegments();
        renderSettingsItem();
        setTimeout(function () {
            isRendering = false;
        }, 100);
    }

    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('click', onDocumentClick, true);
    new MutationObserver(function () {
        if (isRendering) {
            return;
        }
        clearTimeout(renderTimer);
        renderTimer = setTimeout(renderAll, 150);
    }).observe(document.documentElement, { childList: true, subtree: true });
    setInterval(renderPlaybackSegments, 1500);
    setInterval(onVideoTimeUpdate, 200);
    renderAll();
}());
