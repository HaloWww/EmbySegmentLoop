define([], function () {
    'use strict';

    var pluginId = '8c1e7ca2-3f07-4b62-a4d1-929f07509367';

    function getPage(view) {
        if (view && view.classList && view.classList.contains('segmentLoopConfigPage')) {
            return view;
        }
        if (view && view.querySelector) {
            var nestedPage = view.querySelector('.segmentLoopConfigPage');
            if (nestedPage) return nestedPage;
        }
        var pages = document.querySelectorAll('.segmentLoopConfigPage');
        return pages.length ? pages[pages.length - 1] : null;
    }

    function getApiClient() {
        if (typeof ApiClient !== 'undefined' && ApiClient) return ApiClient;
        if (typeof ConnectionManager !== 'undefined' &&
            ConnectionManager &&
            typeof ConnectionManager.currentApiClient === 'function') {
            return ConnectionManager.currentApiClient();
        }
        throw new Error('Emby ApiClient is unavailable.');
    }

    function setLoading(show) {
        if (typeof Dashboard === 'undefined' || !Dashboard) return;
        if (show && typeof Dashboard.showLoadingMsg === 'function') Dashboard.showLoadingMsg();
        if (!show && typeof Dashboard.hideLoadingMsg === 'function') Dashboard.hideLoadingMsg();
    }

    function Controller(view) {
        var page = getPage(view);
        if (!page || page.dataset.segmentLoopInitialized === '1') return;

        var form = page.querySelector('.segmentLoopForm');
        var saveButton = page.querySelector('.segmentLoopSave');
        var status = page.querySelector('.segmentLoopStatus');
        if (!form || !saveButton || !status) return;
        page.dataset.segmentLoopInitialized = '1';

        function showStatus(message, isError) {
            status.textContent = message || '';
            status.classList.toggle('isError', !!isError);
        }

        function finishLoading() {
            setLoading(false);
            saveButton.disabled = false;
        }

        function fail(error) {
            finishLoading();
            console.error('Segment Loop configuration error', error);
            showStatus('操作失败，请检查 Emby 日志或浏览器控制台。', true);
        }

        function loadVersion(apiClient) {
            var versionElement = page.querySelector('.slVersion');
            if (!versionElement || typeof apiClient.getInstalledPlugins !== 'function') return;
            apiClient.getInstalledPlugins().then(function (plugins) {
                var plugin = (plugins || []).filter(function (item) {
                    var id = item.Id || item.Guid || item.id || item.guid || '';
                    return String(id).toLowerCase() === pluginId;
                })[0];
                versionElement.textContent = plugin && (plugin.Version || plugin.version)
                    ? String(plugin.Version || plugin.version)
                    : '未知';
            }).catch(function (error) {
                console.error('Segment Loop version query failed', error);
                versionElement.textContent = '读取失败';
            });
        }

        function load() {
            var apiClient;
            try {
                apiClient = getApiClient();
            } catch (error) {
                fail(error);
                return;
            }

            setLoading(true);
            showStatus('');
            loadVersion(apiClient);
            apiClient.getPluginConfiguration(pluginId).then(function (config) {
                page.querySelector('.slStart').value = config.StartKey || '[';
                page.querySelector('.slEnd').value = config.EndKey || ']';
                page.querySelector('.slCapture').value = config.CaptureKey || 'P';
                page.querySelector('.slPath').value = config.StoragePath || '';
                var cleanupHours = Number(config.CleanupIntervalHours);
                page.querySelector('.slCleanupInterval').value = isFinite(cleanupHours) ? cleanupHours : 24;
                finishLoading();
            }).catch(fail);
        }

        form.addEventListener('submit', function (event) {
            event.preventDefault();
            var apiClient;
            try {
                apiClient = getApiClient();
            } catch (error) {
                fail(error);
                return false;
            }

            saveButton.disabled = true;
            setLoading(true);
            showStatus('');
            apiClient.getPluginConfiguration(pluginId).then(function (config) {
                config.StartKey = page.querySelector('.slStart').value || '[';
                config.EndKey = page.querySelector('.slEnd').value || ']';
                config.CaptureKey = page.querySelector('.slCapture').value || 'P';
                config.StoragePath = page.querySelector('.slPath').value.trim();
                var cleanupHours = parseInt(page.querySelector('.slCleanupInterval').value, 10);
                config.CleanupIntervalHours = isFinite(cleanupHours)
                    ? Math.max(0, Math.min(8760, cleanupHours))
                    : 24;
                return apiClient.updatePluginConfiguration(pluginId, config).then(function () {
                    window.EmbySegmentLoopConfig = {
                        startKey: config.StartKey,
                        endKey: config.EndKey,
                        captureKey: config.CaptureKey
                    };
                });
            }).then(function () {
                finishLoading();
                showStatus('设置已保存。');
            }).catch(fail);
            return false;
        });

        load();
    }

    return Controller;
});
