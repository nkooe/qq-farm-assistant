/** 主进程和每个 Worker 都有独立的两套字典，必须在各自进程刷新。 */
function reloadGameConfig() {
    const errors = [];
    for (const modulePath of ['./gameConfig', '../modern/config/gameConfig']) {
        try {
            if (require(modulePath).loadConfigs() !== true) {
                throw new Error('公共配置加载失败');
            }
        } catch (error) {
            errors.push(`${modulePath}: ${error.message}`);
        }
    }
    return { ok: errors.length === 0, errors };
}

module.exports = { reloadGameConfig };
