(function () {
    'use strict';

    if (window.EmbyPortraitFit && typeof window.EmbyPortraitFit.attach === 'function') {
        if (window.EmbyPortraitFit.version === '2.0.0') {
            window.EmbyPortraitFit.attach(document);
            return;
        }
        if (typeof window.EmbyPortraitFit.detach === 'function') window.EmbyPortraitFit.detach(document);
    }

    var storageKey = 'embyPortraitFit.v1';
    var documents = new WeakMap();
    var controllers = new WeakMap();
    var contextList = [];
    var styleId = 'embyPortraitFitStyle';
    var properties = ['object-fit', 'object-position', 'transform', 'transform-origin', 'cursor', 'touch-action', 'width', 'height', 'max-width', 'max-height'];
    var hostStyles = new WeakMap();

    function clamp(value) {
        value = Number(value);
        return isFinite(value) ? Math.max(0, Math.min(100, value)) : 50;
    }

    function zoomValue(value) {
        value = Number(value);
        return isFinite(value) ? Math.max(1, Math.min(5, value)) : 1;
    }

    function geometry(videoWidth, videoHeight, width, height, x, y, zoom, mode) {
        var eligible = videoWidth > 0 && videoHeight > 0 && width > 0 && height > 0;
        if (!eligible) return { eligible: false, overflow: 0, overflowX: 0, overflowY: 0, sourceLeft: 0, sourceTop: 0, sourceWidth: 0, sourceHeight: 0 };
        var base = mode === 'contain' ? Math.min(width / videoWidth, height / videoHeight) : Math.max(width / videoWidth, height / videoHeight);
        var scale = base * zoomValue(zoom == null ? 1 : zoom);
        var renderedWidth = videoWidth * scale, renderedHeight = videoHeight * scale;
        var overflowX = Math.max(0, renderedWidth - width), overflowY = Math.max(0, renderedHeight - height);
        if (overflowX < .01) overflowX = 0;
        if (overflowY < .01) overflowY = 0;
        var effectiveX = overflowX ? clamp(x) : 50, effectiveY = overflowY ? clamp(y) : 50;
        return { eligible: true, scale: scale, overflow: overflowX, overflowX: overflowX, overflowY: overflowY,
            x: effectiveX, y: effectiveY, sourceLeft: overflowX * effectiveX / 100 / scale,
            sourceTop: overflowY * effectiveY / 100 / scale,
            sourceWidth: Math.min(videoWidth, width / scale), sourceHeight: Math.min(videoHeight, height / scale) };
    }

    function text(element, value) { if (element.textContent !== value) element.textContent = value; }
    function hidden(element, value) { if (element.hidden !== value) element.hidden = value; }
    function listen(target, type, callback, options, cleanup) {
        target.addEventListener(type, callback, options);
        cleanup.push(function () { target.removeEventListener(type, callback, options); });
    }

    function preferences(doc) {
        try {
            var value = JSON.parse(doc.defaultView.localStorage.getItem(storageKey));
            return { mode: value && value.mode === 'cover' ? 'cover' : 'contain',
                x: clamp(value && value.x != null ? value.x : 50), y: clamp(value && value.y != null ? value.y : 50),
                zoom: zoomValue(value && value.zoom != null ? value.zoom : 1) };
        } catch (error) { return { mode: 'contain', x: 50, y: 50, zoom: 1 }; }
    }

    function save(controller) {
        try {
            controller.doc.defaultView.localStorage.setItem(storageKey,
                JSON.stringify({ mode: controller.mode, x: controller.x, y: controller.y, zoom: controller.zoom }));
        } catch (error) {}
    }

    function ensureStyle(context) {
        var doc = context.doc;
        if (doc.getElementById(styleId) || !doc.documentElement) return;
        var style = doc.createElement('style');
        style.id = styleId;
        style.textContent = '.embyPortraitFitTools{box-sizing:border-box;pointer-events:auto;font:13px/1.4 Arial,sans-serif;color:#fff}.embyPortraitFitTools[hidden],.embyPortraitFitPanel[hidden]{display:none!important}.embyPortraitFitTools button{font:inherit;border:1px solid rgba(255,255,255,.3);border-radius:5px;color:#fff;background:rgba(20,20,20,.85);padding:6px 9px;cursor:pointer}.embyPortraitFitTools button:disabled{opacity:.4;cursor:default}.embyPortraitFitTools button[aria-pressed="true"]{border-color:#62d7e6;background:#176471}.embyPortraitFitFloating{position:fixed;z-index:9}.embyPortraitFitPortal{z-index:1000002}.embyPortraitFitToggle{white-space:nowrap;touch-action:manipulation}.embyPortraitFitPanel{position:fixed;z-index:1000003;box-sizing:border-box;width:290px;max-width:calc(100vw - 16px);max-height:calc(100vh - 60px);overflow:auto;padding:12px;border:1px solid #555;border-radius:8px;background:rgba(24,24,24,.97);box-shadow:0 6px 25px #0008;text-align:left}.embyPortraitFitModes,.embyPortraitFitPresets{display:flex;gap:6px;margin-bottom:9px;flex-wrap:wrap}.embyPortraitFitPanel label{display:block;margin:5px 0}.embyPortraitFitPanel input[type="range"]{display:block;width:100%;margin:8px 0 10px;accent-color:#62d7e6;touch-action:none}.embyPortraitFitHint{margin:8px 0 0;opacity:.75;font-size:12px}.embyPortraitFitDrag{width:100%}.embyPortraitFitReset{width:100%;margin-top:8px}.embyPortraitFitClose{float:right;padding:1px 6px!important}.embyPortraitFitHeading{margin:0 0 12px;font-weight:600}.embyPortraitFitTools:focus-within{opacity:1}';
        (doc.head || doc.documentElement).appendChild(style);
    }

    function visible(video) {
        if (!video.isConnected || !video.getClientRects().length) return false;
        for (var node = video; node && node.nodeType === 1; node = node.parentElement) {
            if (node.hidden || node.getAttribute('aria-hidden') === 'true' || node.classList.contains('hide')) return false;
        }
        return true;
    }

    function viewport(video) {
        var doc = video.ownerDocument;
        if ((doc.fullscreenElement || doc.webkitFullscreenElement) === video) {
            var width = video.clientWidth || doc.defaultView.innerWidth;
            var height = video.clientHeight || doc.defaultView.innerHeight;
            return { host: null, rect: { left: 0, top: 0, width: width, height: height, right: width, bottom: height } };
        }
        var host = video.closest('[data-emby-portrait-viewport], .htmlVideoPlayerContainer, .tile') || video.parentElement;
        var rect = host && host.getBoundingClientRect();
        if (rect && rect.width && rect.height) {
            var left = rect.left + (host.clientLeft || 0), top = rect.top + (host.clientTop || 0);
            var width = host.clientWidth || rect.width, height = host.clientHeight || rect.height;
            rect = { left: left, top: top, width: width, height: height, right: left + width, bottom: top + height };
        }
        if (!rect || !rect.width || !rect.height) {
            // clientWidth/clientHeight are layout dimensions unaffected by our scale.
            var box = video.getBoundingClientRect();
            var item = controllers.get(video), applied = item && item.applied && item.geometry;
            var z = applied ? item.zoom : 1;
            var w = video.clientWidth || video.offsetWidth || box.width / z;
            var h = video.clientHeight || video.offsetHeight || box.height / z;
            var left = box.left - (1 - z) * w * (applied ? item.geometry.x : 50) / 100;
            var top = box.top - (1 - z) * h * (applied ? item.geometry.y : 50) / 100;
            rect = { left: left, top: top, width: w, height: h, right: left + w, bottom: top + h };
        }
        return { host: host, rect: rect };
    }

    function restoreProperty(style, name, original) {
        if (original.value) style.setProperty(name, original.value, original.priority);
        else style.removeProperty(name);
    }

    function releaseHost(controller) {
        var host = controller.clipHost;
        if (!host) return;
        var entry = hostStyles.get(host);
        controller.clipHost = null;
        if (!entry) return;
        entry.users = entry.users.filter(function (item) { return item !== controller; });
        if (!entry.users.length) {
            Object.keys(entry.original).forEach(function (name) { restoreProperty(host.style, name, entry.original[name]); });
            hostStyles.delete(host);
        } else if (entry.users.some(function (item) { return item.editing; })) host.style.setProperty('touch-action', 'none', 'important');
        else restoreProperty(host.style, 'touch-action', entry.original['touch-action']);
    }

    function prepareHost(controller, host) {
        if (controller.clipHost !== host) releaseHost(controller);
        if (!host) return;
        var entry = hostStyles.get(host);
        if (!entry) {
            entry = { users: [], original: {} };
            ['overflow', 'overflow-x', 'overflow-y', 'touch-action'].forEach(function (name) {
                entry.original[name] = { value: host.style.getPropertyValue(name), priority: host.style.getPropertyPriority(name) };
            });
            hostStyles.set(host, entry);
        }
        if (entry.users.indexOf(controller) < 0) entry.users.push(controller);
        controller.clipHost = host;
        host.style.setProperty('overflow', 'hidden', 'important');
        if (entry.users.some(function (item) { return item.editing; })) host.style.setProperty('touch-action', 'none', 'important');
        else restoreProperty(host.style, 'touch-action', entry.original['touch-action']);
    }

    function restore(controller) {
        releaseHost(controller);
        if (!controller.original) return;
        properties.forEach(function (name) {
            var previous = controller.original[name];
            restoreProperty(controller.video.style, name, previous);
        });
        controller.original = null;
        controller.applied = false;
    }

    function captureStyles(controller) {
        if (controller.original) return;
        controller.original = {};
        properties.forEach(function (name) {
            controller.original[name] = { value: controller.video.style.getPropertyValue(name),
                priority: controller.video.style.getPropertyPriority(name) };
        });
    }

    function originalTransform(controller) {
        var video = controller.video, style = video.style, saved = {};
        ['transform', 'transform-origin'].forEach(function (name) {
            saved[name] = { value: style.getPropertyValue(name), priority: style.getPropertyPriority(name) };
            restoreProperty(style, name, controller.original[name]);
        });
        // Resolve percentages after the video has its current layout dimensions;
        // caching the computed translate matrix would drift after a resize.
        var computed = controller.doc.defaultView.getComputedStyle ? controller.doc.defaultView.getComputedStyle(video) : style;
        var value = computed.getPropertyValue('transform');
        ['transform', 'transform-origin'].forEach(function (name) { restoreProperty(style, name, saved[name]); });
        return value && value !== 'none' ? value : '';
    }

    function finishDrag(controller) {
        if (controller.drag && controller.drag.target && controller.drag.target.releasePointerCapture) {
            try { controller.drag.target.releasePointerCapture(controller.drag.id); } catch (error) {}
        }
        controller.drag = null;
    }

    function closePanel(controller) {
        controller.open = false;
        controller.anchor = null;
        controller.editing = false;
        finishDrag(controller);
        update(controller);
    }

    function button(doc, label, handler, cleanup) {
        var element = doc.createElement('button');
        element.type = 'button';
        element.textContent = label;
        listen(element, 'click', function (event) {
            event.preventDefault();
            event.stopPropagation();
            handler();
        }, false, cleanup);
        return element;
    }

    function change(controller, values) {
        if (values.mode != null) controller.mode = values.mode === 'cover' ? 'cover' : 'contain';
        if (values.x != null) controller.x = clamp(values.x);
        if (values.y != null) controller.y = clamp(values.y);
        if (values.zoom != null) controller.zoom = zoomValue(values.zoom);
        finishDragIfReset(controller, values);
        save(controller);
        update(controller);
    }

    function finishDragIfReset(controller, values) {
        if (values.reset) { controller.editing = false; finishDrag(controller); }
    }

    function createTools(controller) {
        var doc = controller.doc, cleanup = controller.cleanup;
        var root = doc.createElement('div');
        root.className = 'embyPortraitFitTools';
        ['keydown', 'keyup'].forEach(function (name) {
            // Let native ranges/buttons handle Arrow/Home/End/Space/Tab, while
            // shielding them from the player's global pause/fullscreen shortcuts.
            listen(root, name, function (event) { event.stopPropagation(); }, false, cleanup);
        });
        var toggle = button(doc, '画面缩放', function () {
            controller.anchor = !controller.open ? controller.ui.toggle.getBoundingClientRect() : null;
            controller.open = !controller.open;
            if (!controller.open) { controller.editing = false; finishDrag(controller); }
            update(controller);
        }, cleanup);
        toggle.className = 'embyPortraitFitToggle';
        toggle.setAttribute('aria-label', '画面缩放与裁切位置');
        toggle.setAttribute('aria-expanded', 'false');
        var panel = doc.createElement('div');
        panel.className = 'embyPortraitFitPanel';
        panel.setAttribute('role', 'group');
        panel.setAttribute('aria-label', '画面缩放设置');
        panel.hidden = true;
        var heading = doc.createElement('div');
        heading.className = 'embyPortraitFitHeading';
        var close = button(doc, '×', function () { closePanel(controller); }, cleanup);
        close.className = 'embyPortraitFitClose';
        close.setAttribute('aria-label', '关闭画面缩放设置');
        heading.appendChild(close);
        heading.appendChild(doc.createTextNode('画面缩放'));
        var modes = doc.createElement('div');
        modes.className = 'embyPortraitFitModes';
        var contain = button(doc, '适应画面', function () { change(controller, { mode: 'contain' }); }, cleanup);
        var cover = button(doc, '铺满画面', function () { change(controller, { mode: 'cover' }); }, cleanup);
        modes.appendChild(contain); modes.appendChild(cover);
        var presets = doc.createElement('div');
        presets.className = 'embyPortraitFitPresets';
        var presetValues = [{ x: 0 }, { x: 50, y: 50 }, { x: 100 }, { y: 0 }, { y: 100 }];
        var presetButtons = presetValues.map(function (values, index) {
            var element = button(doc, ['左侧', '居中', '右侧', '上方', '下方'][index], function () { change(controller, values); }, cleanup);
            presets.appendChild(element);
            return element;
        });
        function slider(name, key, minimum, maximum, step, factor) {
            var label = doc.createElement('label'), output = doc.createElement('span'), input = doc.createElement('input');
            input.type = 'range'; input.min = String(minimum); input.max = String(maximum); input.step = String(step);
            input.setAttribute('aria-label', name);
            label.appendChild(output); label.appendChild(input);
            listen(input, 'input', function (event) {
                event.stopPropagation(); var values = {}; values[key] = Number(input.value) / factor; change(controller, values);
            }, false, cleanup);
            return { label: label, output: output, input: input };
        }
        var scale = slider('缩放倍率', 'zoom', 100, 500, 1, 100);
        var horizontal = slider('裁切水平位置', 'x', 0, 100, 1, 1);
        var vertical = slider('裁切垂直位置', 'y', 0, 100, 1, 1);
        var drag = button(doc, '拖动选择画面', function () {
            controller.editing = !controller.editing;
            finishDrag(controller);
            update(controller);
        }, cleanup);
        drag.className = 'embyPortraitFitDrag';
        var reset = button(doc, '重置画面', function () { change(controller, { mode: 'contain', zoom: 1, x: 50, y: 50, reset: true }); }, cleanup);
        reset.className = 'embyPortraitFitReset';
        var hint = doc.createElement('p'); hint.className = 'embyPortraitFitHint';
        panel.appendChild(heading); panel.appendChild(modes); panel.appendChild(scale.label); panel.appendChild(presets);
        panel.appendChild(horizontal.label); panel.appendChild(vertical.label); panel.appendChild(drag); panel.appendChild(reset); panel.appendChild(hint);
        root.appendChild(toggle); root.appendChild(panel);
        controller.ui = { root: root, toggle: toggle, panel: panel, contain: contain, cover: cover,
            presets: presetButtons, presetValues: presetValues, scale: scale, horizontal: horizontal, vertical: vertical, drag: drag, hint: hint };
    }

    function mountTools(controller, rect) {
        var doc = controller.doc, ui = controller.ui;
        var full = doc.fullscreenElement || doc.webkitFullscreenElement;
        var tile = controller.video.closest('.tile');
        var nativePlayer = controller.video.closest('.htmlVideoPlayerContainer');
        var toolbar = nativePlayer && !tile ? Array.prototype.slice.call(doc.querySelectorAll('.videoOsdBottom-buttons-topright')).filter(function (node) {
            return node.getClientRects().length;
        }).pop() : null;
        // Emby hides the whole OSD after a delay. Keep an open editor outside
        // that subtree so its slider and finish button remain usable.
        var useToolbar = controller.open ? null : toolbar;
        var parent = useToolbar || (full && full.tagName !== 'VIDEO' && full.contains(controller.video) ? full : doc.body);
        if (!parent) return;
        if (ui.root.parentNode !== parent) parent.appendChild(ui.root);
        ui.root.classList.toggle('embyPortraitFitFloating', !useToolbar);
        ui.root.classList.toggle('embyPortraitFitPortal', !!(toolbar && controller.open));
        if (!useToolbar) {
            var anchor = controller.open && controller.anchor;
            ui.root.style.left = Math.max(8, Math.min(doc.defaultView.innerWidth - 100, anchor ? anchor.left : rect.right - 100)) + 'px';
            ui.root.style.top = Math.max(8, Math.min(doc.defaultView.innerHeight - 40, anchor ? anchor.top : rect.top + (tile ? 44 : 12))) + 'px';
        } else {
            ui.root.style.removeProperty('left'); ui.root.style.removeProperty('top');
        }
        var toggleRect = ui.toggle.getBoundingClientRect();
        var width = Math.min(290, Math.max(0, doc.defaultView.innerWidth - 16));
        ui.panel.style.left = Math.max(8, Math.min(doc.defaultView.innerWidth - width - 8, toggleRect.right - width)) + 'px';
        var height = ui.panel.getBoundingClientRect().height || 270;
        var top = toolbar ? toggleRect.top - height - 8 : toggleRect.bottom + 6;
        ui.panel.style.top = Math.max(8, Math.min(doc.defaultView.innerHeight - height - 8, top)) + 'px';
        var idle = !!controller.video.closest('.controls-hidden');
        hidden(ui.root, !controller.visible || (idle && !controller.open) || full === controller.video);
    }

    function update(controller) {
        if (controller.destroyed) return;
        var video = controller.video;
        var fullscreen = controller.doc.fullscreenElement || controller.doc.webkitFullscreenElement || null;
        if (controller.fullscreen !== fullscreen) {
            controller.fullscreen = fullscreen;
            controller.editing = false; finishDrag(controller); restore(controller);
        }
        var source = (video.getAttribute('src') || '') + '|' + (video.currentSrc || '');
        if (controller.source !== source) {
            controller.source = source;
            controller.editing = false;
            controller.open = false;
            finishDrag(controller);
            restore(controller);
        }
        var view = viewport(video), rect = view.rect;
        controller.visible = visible(video) && !controller.ended && video.videoWidth > 0 && video.videoHeight > 0;
        controller.viewport = rect;
        controller.geometry = geometry(video.videoWidth, video.videoHeight, rect.width, rect.height, controller.x, controller.y, controller.zoom, controller.mode);
        var apply = controller.visible && controller.geometry.eligible;
        var movable = apply && (controller.geometry.overflowX > 0 || controller.geometry.overflowY > 0);
        if (!movable) { controller.editing = false; finishDrag(controller); }
        if (apply) {
            captureStyles(controller);
            var position = controller.geometry.x + '% ' + controller.geometry.y + '%';
            video.style.setProperty('object-fit', controller.mode, 'important');
            video.style.setProperty('object-position', position, 'important');
            // Normalize the video box before resolving a stylesheet percentage
            // translation used to center the original player element.
            if (view.host) {
                ['width', 'height'].forEach(function (name) { video.style.setProperty(name, '100%', 'important'); });
                ['max-width', 'max-height'].forEach(function (name) { video.style.setProperty(name, 'none', 'important'); });
            }
            if (controller.zoom > 1) {
                // Identical object-position and transform-origin align the scaled
                // content edge, not the video element's letterbox edge. Preserve
                // stylesheet translations used by existing player layouts.
                var baseTransform = originalTransform(controller);
                video.style.setProperty('transform', (baseTransform ? baseTransform + ' ' : '') + 'scale(' + controller.zoom + ')', 'important');
                video.style.setProperty('transform-origin', position, 'important');
            } else {
                restoreProperty(video.style, 'transform', controller.original.transform);
                restoreProperty(video.style, 'transform-origin', controller.original['transform-origin']);
            }
            // Explicit viewport hosts promise that the video may fill their box.
            // Emby and the multiwindow player already use this 100% layout.
            if (controller.zoom > 1 || controller.editing) prepareHost(controller, view.host);
            else releaseHost(controller);
            video.style.setProperty('cursor', controller.editing ? 'grab' : controller.original.cursor.value, controller.editing ? 'important' : controller.original.cursor.priority);
            video.style.setProperty('touch-action', controller.editing ? 'none' : controller.original['touch-action'].value, controller.editing ? 'important' : controller.original['touch-action'].priority);
            controller.applied = true;
        } else {
            controller.editing = false;
            finishDrag(controller);
            restore(controller);
        }
        var ui = controller.ui;
        hidden(ui.panel, !controller.open);
        ui.toggle.setAttribute('aria-expanded', String(controller.open));
        ui.toggle.setAttribute('aria-pressed', String(apply && (controller.mode === 'cover' || controller.zoom > 1)));
        ui.contain.setAttribute('aria-pressed', String(controller.mode === 'contain'));
        ui.cover.setAttribute('aria-pressed', String(controller.mode === 'cover'));
        ui.presets.forEach(function (element, index) {
            var values = ui.presetValues[index];
            element.disabled = values.x != null && values.y != null ? !movable
                : values.x != null ? !controller.geometry.overflowX : !controller.geometry.overflowY;
            element.setAttribute('aria-pressed', String(apply &&
                (values.x == null || Math.abs(controller.geometry.x - values.x) < .5) &&
                (values.y == null || Math.abs(controller.geometry.y - values.y) < .5)));
        });
        ui.scale.input.disabled = !apply;
        ui.scale.input.value = String(Math.round(controller.zoom * 100));
        text(ui.scale.output, '缩放倍率：' + Math.round(controller.zoom * 100) + '%');
        ui.horizontal.input.disabled = !controller.geometry.overflowX;
        ui.vertical.input.disabled = !controller.geometry.overflowY;
        ui.horizontal.input.value = String(controller.geometry.x == null ? 50 : controller.geometry.x);
        ui.vertical.input.value = String(controller.geometry.y == null ? 50 : controller.geometry.y);
        text(ui.horizontal.output, '水平位置：' + Math.round(controller.geometry.x == null ? 50 : controller.geometry.x) + '%');
        text(ui.vertical.output, '垂直位置：' + Math.round(controller.geometry.y == null ? 50 : controller.geometry.y) + '%');
        ui.drag.disabled = !movable;
        ui.drag.setAttribute('aria-pressed', String(controller.editing));
        text(ui.drag, controller.editing ? '完成画面选择' : '拖动选择画面');
        text(ui.hint, controller.editing ? '拖动画面选择裁切位置；点击完成或按 Esc 退出。'
            : apply ? '倍率基于适应或铺满画面；仅在画面溢出的方向移动裁切位置。' : '读取视频尺寸后即可调整画面。');
        mountTools(controller, rect);
    }

    function createController(context, video) {
        var prefs = preferences(context.doc);
        var controller = { context: context, doc: context.doc, video: video, mode: prefs.mode, x: prefs.x, y: prefs.y, zoom: prefs.zoom,
            cleanup: [], original: null, source: null, applied: false, open: false, editing: false,
            ended: !!video.ended, destroyed: false, drag: null };
        controllers.set(video, controller);
        context.items.push(controller);
        createTools(controller);
        ['loadedmetadata', 'loadeddata', 'play'].forEach(function (name) {
            listen(video, name, function () { controller.ended = false; update(controller); }, false, controller.cleanup);
        });
        ['ended', 'emptied'].forEach(function (name) {
            listen(video, name, function () { controller.ended = true; closePanel(controller); }, false, controller.cleanup);
        });
        if (context.win.ResizeObserver) {
            controller.resize = new context.win.ResizeObserver(function () { update(controller); });
            controller.resize.observe(video);
            if (video.parentElement) controller.resize.observe(video.parentElement);
        }
        update(controller);
        return controller;
    }

    function destroyController(controller) {
        if (controller.destroyed) return;
        controller.destroyed = true;
        finishDrag(controller);
        restore(controller);
        controller.cleanup.forEach(function (remove) { remove(); });
        if (controller.resize) controller.resize.disconnect();
        controller.ui.root.remove();
        controllers.delete(controller.video);
    }

    function refresh(context) {
        if (context.destroyed) return;
        ensureStyle(context);
        context.items = context.items.filter(function (controller) {
            if (!controller.video.isConnected || controller.video.ownerDocument !== context.doc) { destroyController(controller); return false; }
            update(controller); return true;
        });
        Array.prototype.forEach.call(context.doc.querySelectorAll('video'), function (video) {
            if (!controllers.has(video)) createController(context, video);
        });
        var children = [];
        Array.prototype.forEach.call(context.doc.querySelectorAll('iframe'), function (frame) {
            try {
                if (frame.contentDocument && frame.contentDocument.documentElement) {
                    children.push(frame.contentDocument);
                    attach(frame.contentDocument);
                }
            } catch (error) {}
        });
        context.children.forEach(function (doc) { if (children.indexOf(doc) < 0) detach(doc); });
        context.children = children;
    }

    function schedule(context) {
        if (context.pending || context.destroyed) return;
        context.pending = context.win.requestAnimationFrame(function () { context.pending = 0; refresh(context); });
    }

    function selectionController(context, event) {
        if (event.target.closest && event.target.closest('button,input,select,a,[role="slider"],.embyPortraitFitTools,.drag-handle,.close,.controls,.videoOsdPositionContainer')) return null;
        return context.items.slice().reverse().filter(function (controller) {
            if (!controller.applied || !controller.editing) return false;
            var rect = controller.viewport;
            if (!rect) return false;
            var targetTile = event.target.closest && event.target.closest('.tile');
            var ownTile = controller.video.closest('.tile');
            if (targetTile && targetTile !== ownTile) return false;
            return event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
        })[0] || null;
    }

    function attach(doc) {
        doc = doc || document;
        var existing = documents.get(doc);
        if (existing && !existing.destroyed) { refresh(existing); return existing.handle; }
        if (!doc.defaultView) return null;
        var context = { doc: doc, win: doc.defaultView, cleanup: [], items: [], children: [], pending: 0, destroyed: false };
        documents.set(doc, context); contextList.push(context);
        context.handle = { refresh: function () { refresh(context); }, destroy: function () { detach(doc); } };
        var changed = function () { schedule(context); };
        ['resize', 'orientationchange', 'pageshow'].forEach(function (name) { listen(context.win, name, changed, false, context.cleanup); });
        listen(context.win, 'pagehide', function (event) { if (!event.persisted) detach(doc); }, false, context.cleanup);
        ['fullscreenchange', 'webkitfullscreenchange', 'visibilitychange'].forEach(function (name) { listen(doc, name, changed, false, context.cleanup); });
        listen(doc, 'load', function (event) { if (event.target && event.target.tagName === 'IFRAME') schedule(context); }, true, context.cleanup);
        listen(doc, 'keydown', function (event) {
            if (event.key !== 'Escape') return;
            context.items.forEach(function (controller) { if (controller.open) closePanel(controller); });
        }, true, context.cleanup);
        listen(doc, 'pointerdown', function (event) {
            if (event.button != null && event.button !== 0) return;
            var item = selectionController(context, event);
            if (!item) return;
            item.drag = { startX: event.clientX, startY: event.clientY, x: item.x, y: item.y, id: event.pointerId, target: event.target };
            if (event.target.setPointerCapture) { try { event.target.setPointerCapture(event.pointerId); } catch (error) {} }
            event.preventDefault(); event.stopImmediatePropagation();
        }, { capture: true, passive: false }, context.cleanup);
        listen(doc, 'click', function (event) {
            if (selectionController(context, event)) { event.preventDefault(); event.stopImmediatePropagation(); }
        }, true, context.cleanup);
        listen(doc, 'dblclick', function (event) {
            if (selectionController(context, event)) { event.preventDefault(); event.stopImmediatePropagation(); }
        }, true, context.cleanup);
        listen(doc, 'pointermove', function (event) {
            context.items.forEach(function (controller) {
                if (!controller.drag || controller.drag.id !== event.pointerId) return;
                var shape = controller.geometry, values = {};
                if (shape.overflowX > 0) values.x = controller.drag.x - (event.clientX - controller.drag.startX) / shape.overflowX * 100;
                if (shape.overflowY > 0) values.y = controller.drag.y - (event.clientY - controller.drag.startY) / shape.overflowY * 100;
                change(controller, values);
                event.preventDefault(); event.stopImmediatePropagation();
            });
        }, { capture: true, passive: false }, context.cleanup);
        ['pointerup', 'pointercancel'].forEach(function (name) {
            listen(doc, name, function (event) {
                context.items.forEach(function (controller) {
                    if (controller.drag && controller.drag.id === event.pointerId) {
                        finishDrag(controller); event.preventDefault(); event.stopImmediatePropagation();
                    }
                });
            }, true, context.cleanup);
        });
        if (context.win.MutationObserver) {
            context.observer = new context.win.MutationObserver(changed);
            // Observing Document, rather than its current documentElement, also
            // survives the Tampermonkey player replacing the entire root tree.
            context.observer.observe(doc, { childList: true, subtree: true, attributes: true,
                attributeFilter: ['src', 'class', 'hidden', 'aria-hidden', 'data-emby-portrait-viewport'] });
        }
        refresh(context);
        return context.handle;
    }

    function detach(doc) {
        var context = documents.get(doc || document);
        if (!context || context.destroyed) return;
        context.destroyed = true;
        if (context.observer) context.observer.disconnect();
        if (context.pending) context.win.cancelAnimationFrame(context.pending);
        context.cleanup.forEach(function (remove) { remove(); });
        context.items.forEach(destroyController);
        context.children.forEach(detach);
        var style = context.doc.getElementById(styleId);
        if (style) style.remove();
        documents.delete(context.doc);
        contextList = contextList.filter(function (value) { return value !== context; });
    }

    window.EmbyPortraitFit = {
        version: '2.0.0', attach: attach, detach: detach, geometry: geometry,
        set: function (video, values) {
            attach(video.ownerDocument);
            var controller = controllers.get(video);
            if (controller) change(controller, values || {});
        },
        getState: function (video) {
            var controller = controllers.get(video);
            return controller ? { mode: controller.mode, x: controller.x, y: controller.y, zoom: controller.zoom, applied: controller.applied,
                eligible: !!(controller.geometry && controller.geometry.eligible), editing: controller.editing } : null;
        }
    };
    attach(document);
}());
