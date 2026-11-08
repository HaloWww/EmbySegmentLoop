(function () {
    'use strict';

    if (window.EmbyPortraitFit && typeof window.EmbyPortraitFit.attach === 'function') {
        window.EmbyPortraitFit.attach(document);
        return;
    }

    var storageKey = 'embyPortraitFit.v1';
    var documents = new WeakMap();
    var controllers = new WeakMap();
    var contextList = [];
    var styleId = 'embyPortraitFitStyle';
    var properties = ['object-fit', 'object-position', 'cursor', 'touch-action', 'width', 'height', 'max-width', 'max-height'];

    function clamp(value) {
        value = Number(value);
        return isFinite(value) ? Math.max(0, Math.min(100, value)) : 50;
    }

    function geometry(videoWidth, videoHeight, width, height, x) {
        var eligible = videoWidth > videoHeight && width > 0 && height > width && videoHeight > 0;
        if (!eligible) return { eligible: false, overflow: 0, sourceLeft: 0, sourceWidth: videoWidth || 0 };
        var scale = Math.max(width / videoWidth, height / videoHeight);
        var overflow = Math.max(0, videoWidth * scale - width);
        return { eligible: true, scale: scale, overflow: overflow,
            sourceLeft: overflow * clamp(x) / 100 / scale, sourceWidth: width / scale };
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
            return { mode: value && value.mode === 'cover' ? 'cover' : 'contain', x: clamp(value && value.x != null ? value.x : 50) };
        } catch (error) { return { mode: 'contain', x: 50 }; }
    }

    function save(controller) {
        try {
            controller.doc.defaultView.localStorage.setItem(storageKey,
                JSON.stringify({ mode: controller.mode, x: controller.x }));
        } catch (error) {}
    }

    function ensureStyle(context) {
        var doc = context.doc;
        if (doc.getElementById(styleId) || !doc.documentElement) return;
        var style = doc.createElement('style');
        style.id = styleId;
        style.textContent = '.embyPortraitFitTools{box-sizing:border-box;pointer-events:auto;font:13px/1.4 Arial,sans-serif;color:#fff}.embyPortraitFitTools[hidden],.embyPortraitFitPanel[hidden]{display:none!important}.embyPortraitFitTools button{font:inherit;border:1px solid rgba(255,255,255,.3);border-radius:5px;color:#fff;background:rgba(20,20,20,.85);padding:6px 9px;cursor:pointer}.embyPortraitFitTools button:disabled{opacity:.4;cursor:default}.embyPortraitFitTools button[aria-pressed="true"]{border-color:#62d7e6;background:#176471}.embyPortraitFitFloating{position:fixed;z-index:9}.embyPortraitFitPortal{z-index:1000002}.embyPortraitFitToggle{white-space:nowrap;touch-action:manipulation}.embyPortraitFitPanel{position:fixed;z-index:1000003;box-sizing:border-box;width:290px;max-width:calc(100vw - 16px);padding:12px;border:1px solid #555;border-radius:8px;background:rgba(24,24,24,.97);box-shadow:0 6px 25px #0008;text-align:left}.embyPortraitFitModes,.embyPortraitFitPresets{display:flex;gap:6px;margin-bottom:9px;flex-wrap:wrap}.embyPortraitFitPanel label{display:block;margin:5px 0}.embyPortraitFitPanel input[type="range"]{display:block;width:100%;margin:8px 0 10px;accent-color:#62d7e6;touch-action:none}.embyPortraitFitHint{margin:8px 0 0;opacity:.75;font-size:12px}.embyPortraitFitDrag{width:100%}.embyPortraitFitClose{float:right;padding:1px 6px!important}.embyPortraitFitHeading{margin:0 0 12px;font-weight:600}.embyPortraitFitTools:focus-within{opacity:1}';
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
            return { host: null, rect: video.getBoundingClientRect() };
        }
        var host = video.closest('[data-emby-portrait-viewport], .htmlVideoPlayerContainer, .tile');
        var rect = (host || video).getBoundingClientRect();
        return { host: host, rect: rect };
    }

    function restore(controller) {
        if (!controller.original) return;
        properties.forEach(function (name) {
            var previous = controller.original[name];
            if (previous.value) controller.video.style.setProperty(name, previous.value, previous.priority);
            else controller.video.style.removeProperty(name);
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
        if (controller.mode !== 'cover') { controller.editing = false; finishDrag(controller); }
        save(controller);
        update(controller);
    }

    function createTools(controller) {
        var doc = controller.doc, cleanup = controller.cleanup;
        var root = doc.createElement('div');
        root.className = 'embyPortraitFitTools';
        var toggle = button(doc, '竖屏填充', function () {
            controller.anchor = !controller.open ? controller.ui.toggle.getBoundingClientRect() : null;
            controller.open = !controller.open;
            if (!controller.open) { controller.editing = false; finishDrag(controller); }
            update(controller);
        }, cleanup);
        toggle.className = 'embyPortraitFitToggle';
        toggle.setAttribute('aria-label', '竖屏填充与画面位置');
        toggle.setAttribute('aria-expanded', 'false');
        var panel = doc.createElement('div');
        panel.className = 'embyPortraitFitPanel';
        panel.setAttribute('role', 'group');
        panel.setAttribute('aria-label', '竖屏填充设置');
        panel.hidden = true;
        var heading = doc.createElement('div');
        heading.className = 'embyPortraitFitHeading';
        var close = button(doc, '×', function () { closePanel(controller); }, cleanup);
        close.className = 'embyPortraitFitClose';
        close.setAttribute('aria-label', '关闭竖屏填充设置');
        heading.appendChild(close);
        heading.appendChild(doc.createTextNode('竖屏填充'));
        var modes = doc.createElement('div');
        modes.className = 'embyPortraitFitModes';
        var contain = button(doc, '原比例', function () { change(controller, { mode: 'contain' }); }, cleanup);
        var cover = button(doc, '填满竖屏', function () { change(controller, { mode: 'cover' }); }, cleanup);
        modes.appendChild(contain); modes.appendChild(cover);
        var presets = doc.createElement('div');
        presets.className = 'embyPortraitFitPresets';
        var presetButtons = [0, 50, 100].map(function (x, index) {
            var element = button(doc, ['左侧', '居中', '右侧'][index], function () { change(controller, { mode: 'cover', x: x }); }, cleanup);
            presets.appendChild(element);
            return element;
        });
        var label = doc.createElement('label');
        var position = doc.createElement('span');
        var range = doc.createElement('input');
        range.type = 'range'; range.min = '0'; range.max = '100'; range.step = '1';
        range.setAttribute('aria-label', '裁切水平位置');
        label.appendChild(position); label.appendChild(range);
        listen(range, 'input', function (event) {
            event.stopPropagation(); change(controller, { mode: 'cover', x: range.value });
        }, false, cleanup);
        var drag = button(doc, '拖动选择画面', function () {
            controller.editing = !controller.editing;
            finishDrag(controller);
            update(controller);
        }, cleanup);
        drag.className = 'embyPortraitFitDrag';
        var hint = doc.createElement('p'); hint.className = 'embyPortraitFitHint';
        panel.appendChild(heading); panel.appendChild(modes); panel.appendChild(presets);
        panel.appendChild(label); panel.appendChild(drag); panel.appendChild(hint);
        root.appendChild(toggle); root.appendChild(panel);
        controller.ui = { root: root, toggle: toggle, panel: panel, contain: contain, cover: cover,
            presets: presetButtons, range: range, position: position, drag: drag, hint: hint };
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
        controller.geometry = geometry(video.videoWidth, video.videoHeight, rect.width, rect.height, controller.x);
        var apply = controller.visible && controller.geometry.eligible && controller.mode === 'cover';
        if (apply) {
            captureStyles(controller);
            video.style.setProperty('object-fit', 'cover', 'important');
            video.style.setProperty('object-position', controller.x + '% 50%', 'important');
            // Explicit viewport hosts promise that the video may fill their box.
            // Emby and the multiwindow player already use this 100% layout.
            if (view.host && video.getBoundingClientRect().height < rect.height * .9) {
                ['width', 'height'].forEach(function (name) { video.style.setProperty(name, '100%', 'important'); });
                ['max-width', 'max-height'].forEach(function (name) { video.style.setProperty(name, 'none', 'important'); });
            }
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
        ui.toggle.setAttribute('aria-pressed', String(apply));
        ui.contain.setAttribute('aria-pressed', String(controller.mode === 'contain'));
        ui.cover.setAttribute('aria-pressed', String(controller.mode === 'cover'));
        ui.presets.forEach(function (element, index) {
            element.disabled = !controller.geometry.eligible;
            element.setAttribute('aria-pressed', String(apply && Math.abs(controller.x - [0, 50, 100][index]) < .5));
        });
        ui.range.disabled = !controller.geometry.eligible;
        ui.range.value = String(controller.x);
        text(ui.position, '显示位置：' + Math.round(controller.x) + '%');
        ui.drag.disabled = !apply;
        ui.drag.setAttribute('aria-pressed', String(controller.editing));
        text(ui.drag, controller.editing ? '完成画面选择' : '拖动选择画面');
        text(ui.hint, controller.editing ? '拖动画面选择裁切位置；点击完成或按 Esc 退出。'
            : controller.geometry.eligible ? '填满竖屏会裁去左右画面，可随时恢复原比例。' : '横屏视频在竖屏播放区域中才会放大填充。');
        mountTools(controller, rect);
    }

    function createController(context, video) {
        var prefs = preferences(context.doc);
        var controller = { context: context, doc: context.doc, video: video, mode: prefs.mode, x: prefs.x,
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
            var rect = controller.video.getBoundingClientRect();
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
            item.drag = { startX: event.clientX, x: item.x, id: event.pointerId, target: event.target };
            if (event.target.setPointerCapture) { try { event.target.setPointerCapture(event.pointerId); } catch (error) {} }
            event.preventDefault(); event.stopImmediatePropagation();
        }, { capture: true, passive: false }, context.cleanup);
        listen(doc, 'click', function (event) {
            if (selectionController(context, event)) { event.preventDefault(); event.stopImmediatePropagation(); }
        }, true, context.cleanup);
        listen(doc, 'pointermove', function (event) {
            context.items.forEach(function (controller) {
                if (!controller.drag || controller.drag.id !== event.pointerId) return;
                var overflow = controller.geometry.overflow;
                if (overflow > 0) change(controller, { x: controller.drag.x - (event.clientX - controller.drag.startX) / overflow * 100 });
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
        version: '1.0.0', attach: attach, detach: detach, geometry: geometry,
        set: function (video, values) {
            attach(video.ownerDocument);
            var controller = controllers.get(video);
            if (controller) change(controller, values || {});
        },
        getState: function (video) {
            var controller = controllers.get(video);
            return controller ? { mode: controller.mode, x: controller.x, applied: controller.applied,
                eligible: !!(controller.geometry && controller.geometry.eligible), editing: controller.editing } : null;
        }
    };
    attach(document);
}());
