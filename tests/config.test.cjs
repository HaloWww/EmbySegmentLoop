const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

test('highlight mode loads and saves while preserving existing plugin configuration', async () => {
    const config = { StartKey: '[', EndKey: ']', CaptureKey: 'P', StoragePath: '/existing/segments.db',
        CleanupIntervalHours: 48, CardHighlightMode: 'Segments' };
    let submit, updated, renders = 0, Controller;
    const fields = {};
    for (const name of ['slStart', 'slEnd', 'slCapture', 'slPath', 'slCleanupInterval', 'slCardHighlightMode'])
        fields['.' + name] = { value: '' };
    fields['.segmentLoopForm'] = { addEventListener: (name, handler) => { submit = handler; } };
    fields['.segmentLoopSave'] = { disabled: true };
    fields['.segmentLoopStatus'] = { textContent: '', classList: { toggle() {} } };
    const page = { classList: { contains: () => true }, dataset: {}, querySelector: key => fields[key] };
    const context = {
        console,
        define: (dependencies, factory) => { Controller = factory(); },
        ApiClient: {
            getPluginConfiguration: async () => ({ ...config }),
            updatePluginConfiguration: async (id, value) => { updated = value; }
        },
        EmbySegLoop: { renderAll: () => { renders++; } }
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(require('node:path').join(__dirname, '../config.js'), 'utf8'), context);
    Controller(page);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(fields['.slCardHighlightMode'].value, 'Segments');
    fields['.slCardHighlightMode'].value = 'None';
    submit({ preventDefault() {} });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(updated.CardHighlightMode, 'None');
    assert.equal(updated.StoragePath, config.StoragePath);
    assert.equal(updated.CleanupIntervalHours, 48);
    assert.equal(context.EmbySegmentLoopConfig.cardHighlightMode, 'None');
    assert.equal(renders, 1);
    assert.equal(fields['.segmentLoopStatus'].textContent, '设置已保存。');
});
