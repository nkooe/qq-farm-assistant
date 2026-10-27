// Adapted from reference project (ISC). Synthetic protocol tests; no account data.
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildActivityDirectory } = require('../src/modern/services/activity-center');
const { getServerTimeSec } = require('../src/modern/utils/utils');

test('milk tea and identically named share reward instances keep independent directory entries', () => {
    const now = getServerTimeSec();
    const windows = ['2026110100', '2026110101', '2026110102', '2026110103', '2026110104']
        .map(id => ({ id, name: '奶茶热销中', beginTime: now - 100, endTime: now + 100 }));
    windows.push({ id: '2026092501', name: '快乐不独享', beginTime: now - 100, endTime: now + 100 });
    const directory = buildActivityDirectory(windows, null, null, null, null);
    const milk = directory.find(entry => entry.gameplayKey === 'milk');
    assert.deepEqual(milk.activityIds, ['2026110100', '2026110101', '2026110102', '2026110103']);
    const share = directory.filter(entry => entry.gameplayKey === 'happy');
    assert.equal(share.length, 2);
    for (const id of ['2026110104', '2026092501']) {
        const instance = share.find(entry => entry.instanceId === id);
        assert.equal(instance.name, '快乐不独享');
        assert.deepEqual(instance.activityIds, [id]);
        assert.equal(instance.detailTarget, 'happy');
    }
});

test('directory excludes expired, future and unconfirmed windows before grouping same-name instances', () => {
    const now = getServerTimeSec();
    const windows = [
        { id: 'active', name: '同名活动', beginTime: now - 10, endTime: now + 100 },
        { id: 'ended', name: '同名活动', beginTime: now - 100, endTime: now },
        { id: 'expired', name: '历史活动', beginTime: now - 100, endTime: now - 10 },
        { id: 'future', name: '同名活动', beginTime: now + 50, endTime: now + 200 },
        { id: 'unknown', name: '未知时间', beginTime: 0, endTime: 0 },
        { id: 'invalid', name: '错误时间', beginTime: 0, endTime: Infinity },
    ];
    const directory = buildActivityDirectory(windows, null, null, null, null);
    assert.equal(directory.length, 1);
    assert.deepEqual(directory[0].activityIds, ['active']);
    assert.equal(directory[0].startTime, now - 10);
    assert.equal(directory[0].endTime, now + 100);
});
