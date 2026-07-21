(function () {
    'use strict';

    var storageKey = 'embySegmentLoop.v1';
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
    var pendingSegmentLaunch = null;
    var loopSeekState = {
        inProgress: false,
        video: null,
        targetMs: 0,
        startedAt: 0,
        timeoutId: null,
        reason: ''
    };
    var loopSession = null;
    var loopDiagnostics = [];

    function addLoopDiagnostic(eventName, details) {
        var entry = {
            time: new Date().toISOString(),
            event: eventName,
            details: details || {}
        };
        loopDiagnostics.push(entry);
        if (loopDiagnostics.length > 200) {
            loopDiagnostics.splice(0, loopDiagnostics.length - 200);
        }
        console.info('[SegmentLoop]', eventName, JSON.stringify(entry.details));
        return entry;
    }

    function safeMediaPath(url) {
        if (!url) return '';
        try {
            return new URL(url, window.location.href).pathname;
        } catch (error) {
            return String(url).split('?')[0];
        }
    }

    function getBufferedRanges(video) {
        var ranges = [];
        if (!video || !video.buffered) return ranges;
        for (var i = 0; i < video.buffered.length; i++) {
            ranges.push({
                start: Math.round(video.buffered.start(i) * 1000) / 1000,
                end: Math.round(video.buffered.end(i) * 1000) / 1000
            });
        }
        return ranges;
    }

    function isSegmentBuffered(video, segment) {
        var start = segment.startMs / 1000;
        var end = segment.endMs / 1000;
        var ranges = getBufferedRanges(video);
        return ranges.some(function (range) {
            return range.start <= start + 0.05 && range.end >= end - 0.05;
        });
    }

    function getMediaResourceSnapshot(video) {
        var path = safeMediaPath(video && (video.currentSrc || video.src));
        var result = {
            path: path,
            requestCount: 0,
            transferSize: 0,
            encodedBodySize: 0,
            decodedBodySize: 0,
            lastStartTime: 0
        };
        if (!path || !window.performance || !performance.getEntriesByType) return result;
        performance.getEntriesByType('resource').forEach(function (entry) {
            if (safeMediaPath(entry.name) !== path) return;
            result.requestCount += 1;
            result.transferSize += Number(entry.transferSize) || 0;
            result.encodedBodySize += Number(entry.encodedBodySize) || 0;
            result.decodedBodySize += Number(entry.decodedBodySize) || 0;
            result.lastStartTime = Math.max(result.lastStartTime, Number(entry.startTime) || 0);
        });
        return result;
    }

    function resourceDelta(before, after) {
        before = before || {};
        after = after || {};
        return {
            requestCount: Math.max(0, (after.requestCount || 0) - (before.requestCount || 0)),
            transferSize: Math.max(0, (after.transferSize || 0) - (before.transferSize || 0)),
            encodedBodySize: Math.max(0, (after.encodedBodySize || 0) - (before.encodedBodySize || 0)),
            decodedBodySize: Math.max(0, (after.decodedBodySize || 0) - (before.decodedBodySize || 0))
        };
    }

    function resetLoopSeekState() {
        if (loopSeekState.timeoutId) {
            clearTimeout(loopSeekState.timeoutId);
        }
        loopSeekState.inProgress = false;
        loopSeekState.video = null;
        loopSeekState.targetMs = 0;
        loopSeekState.startedAt = 0;
        loopSeekState.timeoutId = null;
        loopSeekState.reason = '';
    }

    function stopActiveLoop(reason) {
        if (loopSession && loopSession.video) {
            if (loopSession.frameRequestId !== null && loopSession.video.cancelVideoFrameCallback) {
                loopSession.video.cancelVideoFrameCallback(loopSession.frameRequestId);
                loopSession.frameRequestId = null;
            }
            var finalSnapshot = getMediaResourceSnapshot(loopSession.video);
            var finalDelta = resourceDelta(loopSession.lastResourceSnapshot, finalSnapshot);
            loopSession.networkRequestsObserved += finalDelta.requestCount;
            loopSession.transferBytesObserved += finalDelta.transferSize;
            addLoopDiagnostic('loop-session-stop', {
                reason: reason,
                loops: loopSession.loops,
                networkRequestsObserved: loopSession.networkRequestsObserved,
                transferBytesObserved: loopSession.transferBytesObserved,
                finalResourceDelta: finalDelta
            });
        }
        resetLoopSeekState();
        loopSession = null;
        activeSegment = null;
    }

    function startLoopSession(video, itemId, segment) {
        var snapshot = getMediaResourceSnapshot(video);
        loopSession = {
            video: video,
            itemId: itemId,
            segmentId: segment.id,
            loops: 0,
            networkRequestsObserved: 0,
            transferBytesObserved: 0,
            lastResourceSnapshot: snapshot,
            frameRequestId: null
        };
        addLoopDiagnostic('loop-session-start', {
            itemId: itemId,
            segmentId: segment.id,
            startMs: segment.startMs,
            endMs: segment.endMs,
            mediaPath: snapshot.path,
            buffered: getBufferedRanges(video),
            segmentBuffered: isSegmentBuffered(video, segment),
            resourceSnapshot: snapshot
        });
        startLoopFrameWatch(video);
    }

    function finishLoopSeek(video, outcome) {
        if (!loopSeekState.inProgress || loopSeekState.video !== video) return;
        var elapsedMs = Date.now() - loopSeekState.startedAt;
        var reason = loopSeekState.reason;
        var targetMs = loopSeekState.targetMs;
        resetLoopSeekState();
        addLoopDiagnostic('loop-seek-finish', {
            outcome: outcome,
            reason: reason,
            targetMs: targetMs,
            currentMs: Math.round(video.currentTime * 1000),
            elapsedMs: elapsedMs,
            paused: video.paused,
            seeking: video.seeking,
            readyState: video.readyState,
            networkState: video.networkState,
            buffered: getBufferedRanges(video)
        });
        if (outcome !== 'timeout' && !video.seeking) {
            resumeLoopPlayback(video, 'seek-' + outcome);
        }
    }

    function resumeLoopPlayback(video, reason) {
        if (!activeSegment || !loopSession || loopSession.video !== video || !video.paused) return;
        addLoopDiagnostic('loop-resume-start', {
            reason: reason,
            currentMs: Math.round(video.currentTime * 1000),
            readyState: video.readyState,
            networkState: video.networkState
        });
        try {
            var playResult = video.play();
            if (playResult && playResult.catch) {
                playResult.catch(function (error) {
                    addLoopDiagnostic('loop-play-rejected', {
                        reason: reason,
                        message: error && error.message || String(error)
                    });
                });
            }
        } catch (error) {
            addLoopDiagnostic('loop-play-error', {
                reason: reason,
                message: error && error.message || String(error)
            });
        }
    }

    function scheduleLoopSeekTimeout(video) {
        loopSeekState.timeoutId = setTimeout(function () {
            if (!loopSeekState.inProgress || loopSeekState.video !== video) return;
            addLoopDiagnostic('loop-seek-timeout-abort', {
                targetMs: loopSeekState.targetMs,
                currentMs: Math.round(video.currentTime * 1000),
                paused: video.paused,
                seeking: video.seeking,
                readyState: video.readyState,
                networkState: video.networkState,
                buffered: getBufferedRanges(video)
            });
            finishLoopSeek(video, 'timeout');
            stopActiveLoop('seek-timeout');
            try { video.pause(); } catch (error) { }
            showToast('循环回跳超时，已停止循环以避免重复取流');
        }, 2500);
    }

    function requestLoopSeek(video, reason) {
        if (!activeSegment || !video) return;
        if (loopSeekState.inProgress) return;

        var segment = activeSegment.segment;
        var snapshot = getMediaResourceSnapshot(video);
        var delta = loopSession ? resourceDelta(loopSession.lastResourceSnapshot, snapshot) : {};
        if (loopSession) {
            if (reason !== 'activate') loopSession.loops += 1;
            loopSession.networkRequestsObserved += delta.requestCount || 0;
            loopSession.transferBytesObserved += delta.transferSize || 0;
            loopSession.lastResourceSnapshot = snapshot;
        }

        loopSeekState.inProgress = true;
        loopSeekState.video = video;
        loopSeekState.targetMs = segment.startMs;
        loopSeekState.startedAt = Date.now();
        loopSeekState.reason = reason;
        addLoopDiagnostic('loop-seek-start', {
            reason: reason,
            loopNumber: loopSession ? loopSession.loops : 0,
            fromMs: Math.round(video.currentTime * 1000),
            targetMs: segment.startMs,
            segmentBuffered: isSegmentBuffered(video, segment),
            buffered: getBufferedRanges(video),
            mediaResourceDeltaSinceLastLoop: delta,
            paused: video.paused,
            readyState: video.readyState,
            networkState: video.networkState
        });

        scheduleLoopSeekTimeout(video);

        try {
            video.currentTime = Math.max(0, segment.startMs / 1000);
            setTimeout(function () {
                if (loopSeekState.inProgress && loopSeekState.video === video &&
                    !video.seeking && Math.abs(video.currentTime * 1000 - segment.startMs) < 100) {
                    finishLoopSeek(video, 'already-at-target');
                }
            }, 50);
        } catch (error) {
            addLoopDiagnostic('loop-seek-error', { message: error && error.message || String(error) });
            finishLoopSeek(video, 'error');
        }
    }

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
            endKey: config.endKey || ']',
            captureKey: config.captureKey || 'P'
        };
    }

    function getItemSegments(itemId) {
        if (!itemId) {
            return [];
        }
        var cached = itemSegmentCache[itemId];
        if (Array.isArray(cached)) {
            if (cached.length) return sortSegments(cached);
            // empty cache – fall through to localStorage in case data was
            // saved by another tab or before the server responded empty
        }
        var local = getState().items[itemId] || [];
        if (local.length) itemSegmentCache[itemId] = cloneSegments(local);
        return sortSegments(local);
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
        return persistItemSegments(itemId, normalized).then(function (saved) {
            if (saved) {
                removeLegacyItem(itemId);
            } else {
                var state = getState();
                state.items[itemId] = normalized;
                saveState(state);
            }
            return saved;
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
        // 1. Check URL query/hash
        var text = location.href;
        var match = text.match(/[?&#\/](?:id|itemid|itemId)=([^&#]+)/);
        if (match) return decodeURIComponent(match[1]);
        // 2. Check data attributes on detail page
        var el = document.querySelector('.itemView[data-itemid], [data-itemid]');
        if (el) return el.getAttribute('data-itemid');
        // 3. Look for an img whose src contains /Items/{id}/
        var img = document.querySelector('.detailImageContainer img[src*="/Items/"]');
        if (img) { match = img.src.match(/\/Items\/([^\/]+)/); if (match) return match[1]; }
        return null;
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
        overlay.innerHTML = '<div class="embySegmentDialog"><div class="embySegmentDialogHeader"><h2>片段编辑</h2><button type="button" class="embySegmentDialogClose paper-icon-button-light" title="取消" aria-label="关闭"><i class="md-icon">close</i></button></div><div class="embySegmentDialogBody"><div class="embySegmentHelp">时间支持秒或 HH:MM:SS.mmm，例如 83.250 或 0:01:23.250。快捷键请在 Emby 插件设置中修改。</div><div class="embySegmentEditorRows"></div><button type="button" class="embySegmentEditorAdd raised">+ 新建片段</button></div><div class="embySegmentDialogFooter"><button type="button" class="embySegmentCancel raised cancel">取消</button><button type="button" class="embySegmentSave raised submit">保存</button></div></div>';
        document.body.appendChild(overlay);

        function syncRowsToSegments() {
            var byId = {};
            segments.forEach(function (segment) { byId[String(segment.id)] = segment; });
            Array.prototype.slice.call(overlay.querySelectorAll('.embySegmentEditorRow')).forEach(function (row) {
                var segment = byId[row.dataset.segmentId];
                if (!segment) return;
                segment.name = row.querySelector('.embySegmentName').value;
                segment.startText = row.querySelector('.embySegmentStart').value;
                segment.endText = row.querySelector('.embySegmentEnd').value;
            });
        }

        function renderRows() {
            var rows = overlay.querySelector('.embySegmentEditorRows');
            rows.innerHTML = '';
            segments.forEach(function (segment, index) {
                var row = document.createElement('div');
                row.className = 'embySegmentEditorRow';
                row.dataset.index = String(index);
                row.dataset.segmentId = String(segment.id);
                row.innerHTML = '<label><span>名称</span><input class="embySegmentName" value=""></label><label><span>开始</span><input class="embySegmentStart" value=""></label><label><span>结束</span><input class="embySegmentEnd" value=""></label><button type="button" class="embySegmentDelete paper-icon-button-light" title="删除" aria-label="删除片段"><i class="md-icon">delete</i></button>';
                row.querySelector('.embySegmentName').value = segment.name || ('片段 ' + (index + 1));
                row.querySelector('.embySegmentStart').value = segment.startText != null ? segment.startText : formatTime(segment.startMs);
                row.querySelector('.embySegmentEnd').value = segment.endText != null ? segment.endText : formatTime(segment.endMs);
                row.querySelector('.embySegmentDelete').onclick = function () {
                    syncRowsToSegments();
                    segments = segments.filter(function (item) { return String(item.id) !== row.dataset.segmentId; });
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
            syncRowsToSegments();
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
            syncRowsToSegments();
            var newSegments = editingSingle ? originalSegments.filter(function (segment) {
                return segment.id !== selectedSegment.id;
            }) : [];
            var invalid = false;
            var rowsById = {};
            Array.prototype.slice.call(overlay.querySelectorAll('.embySegmentEditorRow')).forEach(function (row) {
                rowsById[row.dataset.segmentId] = row;
                row.classList.remove('embySegmentInvalid');
            });
            segments.forEach(function (segment, index) {
                var row = rowsById[String(segment.id)];
                if (!row) return;
                var startMs = parseTime(segment.startText);
                var endMs = parseTime(segment.endText);
                if (!isFinite(startMs) || !isFinite(endMs) || endMs <= startMs) {
                    invalid = true;
                    row.classList.add('embySegmentInvalid');
                    return;
                }
                newSegments.push({
                    id: segment.id || String(Date.now() + index),
                    name: String(segment.name || '').trim() || ('片段 ' + (index + 1)),
                    startMs: startMs,
                    endMs: endMs,
                    order: getSegmentOrder(segment, index)
                });
            });
            if (invalid) {
                showToast('请修正无效片段时间');
                return;
            }
            var saveButton = overlay.querySelector('.embySegmentSave');
            saveButton.disabled = true;
            setItemSegments(itemId, newSegments).then(function (saved) {
                saveButton.disabled = false;
                if (!saved) {
                    showToast('数据库保存失败，请重试');
                    return;
                }
                closeEditor();
                renderAll();
                showToast('片段设置已保存');
            });
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
        stopActiveLoop('replace-from-detail');
        var video = getVideo();
        if (video) {
            activateSegment(itemId, segment);
            return;
        }
        pendingSegmentLaunch = { itemId: itemId, segmentId: segment.id, time: Date.now() };
        currentPlaybackItemId = itemId;
        rememberPlaybackItemId(itemId);
        var playButton = null;
        var buttons = document.querySelectorAll('.btnPlay:not(.hide), .btnMainPlay:not(.hide), .btnResume:not(.hide)');
        for (var si = 0; si < buttons.length; si++) {
            if (isRendered(buttons[si])) {
                playButton = buttons[si];
                break;
            }
        }
        if (playButton) {
            segmentLaunchInProgress = true;
            playButton.click();
            segmentLaunchInProgress = false;
        } else {
            showToast('未找到播放按钮');
            pendingSegmentLaunch = null;
        }
    }

    function activateSegment(itemId, segment) {
        var video = getVideo();
        if (!video) {
            return;
        }
        if (video.currentTime > 1 && currentPlaybackItemId && currentPlaybackItemId !== itemId) {
            return;
        }
        if (activeSegment && activeSegment.itemId === itemId && activeSegment.segment.id === segment.id) {
            stopActiveLoop('user-cancelled');
            renderOsdSegments(itemId);
            showToast('已取消片段循环');
            return;
        }
        stopActiveLoop('replace-active-segment');
        rememberPlaybackItemId(itemId);
        activeSegment = { itemId: itemId, segment: segment };
        startLoopSession(video, itemId, segment);
        requestLoopSeek(video, 'activate');
        renderOsdSegments(itemId);
        showToast('循环播放：' + segment.name);
    }

    function onVideoTimeUpdate(videoOrEvent) {
        if (!activeSegment) {
            return;
        }
        var video = videoOrEvent && videoOrEvent.tagName === 'VIDEO'
            ? videoOrEvent
            : this && this.tagName === 'VIDEO'
                ? this
                : getVideo();
        if (!video) {
            return;
        }
        if (loopSeekState.inProgress) return;
        var currentMs = video.currentTime * 1000;
        if (currentMs >= activeSegment.segment.endMs) {
            requestLoopSeek(video, 'segment-end');
        } else if (currentMs < activeSegment.segment.startMs - 750) {
            requestLoopSeek(video, 'before-segment-start');
        }
    }

    function onLoopSeeked(event) {
        finishLoopSeek(event.currentTarget, 'seeked');
    }

    function onLoopPlaybackState(event) {
        if (!activeSegment || !loopSession || loopSession.video !== event.currentTarget) return;
        var video = event.currentTarget;
        addLoopDiagnostic('loop-media-' + event.type, {
            currentMs: Math.round(video.currentTime * 1000),
            paused: video.paused,
            seeking: video.seeking,
            readyState: video.readyState,
            networkState: video.networkState,
            buffered: getBufferedRanges(video),
            resourceSnapshot: getMediaResourceSnapshot(video)
        });
    }

    function startLoopFrameWatch(video) {
        if (!video.requestVideoFrameCallback || !loopSession || loopSession.video !== video ||
            loopSession.frameRequestId !== null) return;
        var onFrame = function () {
            if (!loopSession || loopSession.video !== video || !activeSegment || !video.isConnected) return;
            loopSession.frameRequestId = null;
            onVideoTimeUpdate(video);
            if (loopSession && loopSession.video === video && activeSegment) {
                loopSession.frameRequestId = video.requestVideoFrameCallback(onFrame);
            }
        };
        loopSession.frameRequestId = video.requestVideoFrameCallback(onFrame);
    }

    function ensureVideoHook() {
        var video = getVideo();
        if (video && !video.embySegmentLoopHooked) {
            video.embySegmentLoopHooked = true;
            video.addEventListener('timeupdate', onVideoTimeUpdate);
            video.addEventListener('ended', onVideoTimeUpdate);
            video.addEventListener('seeked', onLoopSeeked);
            video.addEventListener('waiting', onLoopPlaybackState);
            video.addEventListener('stalled', onLoopPlaybackState);
            video.addEventListener('canplay', onLoopPlaybackState);
            video.addEventListener('pause', onLoopPlaybackState);
            video.addEventListener('playing', onLoopPlaybackState);
        }
    }

    function renderDetailSegments() {
        var buttonsList = document.querySelectorAll('.mainDetailButtons');
        if (!buttonsList.length) return;
        for (var i = 0; i < buttonsList.length; i++) {
            var b = buttonsList[i];
            var itemId = getUrlItemId();
            if (!itemId) continue;
            var parent = b.parentNode;
            var host = parent.querySelector('.embySegmentDetailList');
            if (host && host.getAttribute('data-segitem') !== itemId) {
                host.remove();
                host = null;
            }
            if (!host) {
                host = document.createElement('div');
                host.className = 'embySegmentDetailList verticalFieldItem detail-lineItem';
                host.setAttribute('data-segitem', itemId);
                parent.insertBefore(host, b.nextSibling);
            }
            fillDetailHost(host, itemId);
        }
    }

    function fillDetailHost(host, itemId) {
        ensureItemLoaded(itemId).then(function () {
            if (!host.isConnected || host.getAttribute('data-segitem') !== itemId) return;
            var segments = getItemSegments(itemId);
            var key = segments.map(function (s) { return s.id; }).join(',');
            if (host.getAttribute('data-segkey') === key) return;
            host.setAttribute('data-segkey', key);
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
        });
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
        if (!itemId || !pendingSegmentLaunch) {
            return;
        }
        if (pendingSegmentLaunch.itemId !== itemId) {
            return;
        }
        if (Date.now() - pendingSegmentLaunch.time > 60000) {
            pendingSegmentLaunch = null;
            return;
        }
        var segment = getItemSegments(itemId).filter(function (item) { return item.id === pendingSegmentLaunch.segmentId; })[0];
        if (segment) {
            pendingSegmentLaunch = null;
            activateSegment(itemId, segment);
        }
    }

    function tryAnyPendingSegment() {
        if (!pendingSegmentLaunch) return;
        tryPendingSegment(pendingSegmentLaunch.itemId);
    }

    function renderPlaybackSegments() {
        var generation = ++playbackRenderGeneration;
        ensureVideoHook();
        if (!getVideo()) {
            stopActiveLoop('video-unavailable');
            markStartMs = null;
            // Keep currentPlaybackItemId – clearing it here would forget which
            // video we were watching and prevent OSD buttons from showing when
            // the user switches to a new video before getCurrentPlaybackItem()
            // has resolved.
            Array.prototype.slice.call(document.querySelectorAll('.embySegmentOsdList')).forEach(function (host) {
                host.remove();
            });
            return;
        }
        tryAnyPendingSegment();

        // Show whatever we can IMMEDIATELY while waiting for the async call
        var quickId = getRememberedPlaybackItemId();
        if (quickId) {
            ensureItemLoaded(quickId);
            renderOsdSegments(quickId);
            tryPendingSegment(quickId);
        }

        getCurrentPlaybackItem().then(function (item) {
            if (generation !== playbackRenderGeneration || !getVideo()) {
                return;
            }
            var itemId = item && item.Id;
            if (!itemId) {
                var rememberedItemId = getRememberedPlaybackItemId();
                if (rememberedItemId) {
                    renderOsdSegments(rememberedItemId);
                    tryPendingSegment(rememberedItemId);
                }
                return;
            }
            rememberPlaybackItemId(itemId);
            if (itemId === quickId) return;  // already rendered above
            ensureItemLoaded(itemId);
            renderOsdSegments(itemId);
            tryPendingSegment(itemId);
        });
    }

    function capturePoster(video) {
        try {
            var canvas = document.createElement('canvas');
            canvas.width = video.videoWidth || 1920;
            canvas.height = video.videoHeight || 1080;
            var ctx = canvas.getContext('2d');
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            canvas.toBlob(function (blob) {
                if (!blob) { showToast('\u622a\u56fe\u5931\u8d25'); return; }
                var file = new File([blob], 'poster.jpg', { type: 'image/jpeg' });
                getCurrentPlaybackItem().then(function (item) {
                    var itemId = item && item.Id || getRememberedPlaybackItemId();
                    if (!itemId) { showToast('\u65e0\u6cd5\u8bc6\u522b\u89c6\u9891'); return; }
                    var apiClient = null;
                    if (typeof ApiClient !== 'undefined') apiClient = ApiClient;
                    else if (window.require) {
                        require(['connectionManager'], function (cm) {
                            var conn = cm.default || cm;
                            var api = conn.getApiClient(item);
                            doUpload(api, itemId, file);
                        });
                        return;
                    }
                    if (apiClient) doUpload(apiClient, itemId, file);
                    else showToast('\u65e0\u6cd5\u83b7\u53d6 API \u5ba2\u6237\u7aef');
                });
            }, 'image/jpeg', 0.92);
        } catch(e) { showToast('\u622a\u56fe\u5931\u8d25: ' + e.message); }
    }

    function doUpload(apiClient, itemId, file) {
        apiClient.uploadItemImage(itemId, 'Primary', null, file).then(function () {
            showToast('\u6d77\u62a5\u5df2\u66f4\u65b0\uff0c\u5237\u65b0\u9875\u9762\u67e5\u770b');
        }).catch(function () {
            showToast('\u4e0a\u4f20\u5931\u8d25\uff0c\u8bf7\u786e\u8ba4\u6709\u7f16\u8f91\u6761\u76ee\u56fe\u7247\u7684\u6743\u9650');
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
        var isCaptureKey = e.key === settings.captureKey || (e.key && e.key.toLowerCase && e.key.toLowerCase() === settings.captureKey.toLowerCase());
        var isStartEnd = e.key === settings.startKey || e.key === settings.endKey;

        if (!isStartEnd && !isCaptureKey) {
            return;
        }
        e.preventDefault();

        if (isCaptureKey) {
            capturePoster(video);
            return;
        }
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
        var playButton = e.target && e.target.closest && e.target.closest('.btnResume, .btnMainPlay, .btnPlay, .cardOverlayButton-fab, .cardOverlayFab-primary, [data-action="play"], [data-action="resume"], [data-action="playallfromhere"]');
        if (!playButton || playButton.closest('.embySegmentDetailList') || segmentLaunchInProgress) {
            return;
        }
        stopActiveLoop('normal-playback-click');
        markStartMs = null;
        pendingSegmentLaunch = null;
        currentPlaybackItemId = null;
        localStorage.removeItem(rememberedItemKey);
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

    function renderAll() {
        isRendering = true;
        injectStyle();
        renderDetailSegments();
        renderPlaybackSegments();
        setTimeout(function () {
            isRendering = false;
        }, 100);
    }

    window.EmbySegLoop = {
        render: renderDetailSegments,
        renderAll: renderAll,
        getDiagnostics: function () { return loopDiagnostics.slice(); },
        clearDiagnostics: function () { loopDiagnostics.length = 0; }
    };
    document.addEventListener('click', onDocumentClick, true);
    document.addEventListener('keydown', onKeyDown);
    new MutationObserver(function () {
        if (isRendering) {
            return;
        }
        clearTimeout(renderTimer);
        renderTimer = setTimeout(renderAll, 150);
    }).observe(document.documentElement, { childList: true, subtree: true });
    setInterval(renderPlaybackSegments, 1500);
    // Periodic check for detail pages – catches view restoration (display:none→block)
    setInterval(renderAll, 500);

    renderAll();
}());
