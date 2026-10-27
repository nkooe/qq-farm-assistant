const SELECTED_ACTIONS = ['fertilizeNormal', 'fertilizeOrganic', 'clear', 'harvest', 'remove'];

function validateFarmSelection(action, landIds) {
    if (!SELECTED_ACTIONS.includes(action)) throw new Error('不支持的选地操作');
    if (!Array.isArray(landIds) || !landIds.length) throw new Error('请先选择土地');
    if (landIds.length > 64) throw new Error('一次最多选择 64 块土地');
    if (landIds.some(id => typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0)) {
        throw new Error('土地ID必须是正整数');
    }
    return [...new Set(landIds)];
}

module.exports = { validateFarmSelection };
