const fs = require('node:fs');
const { getResourcePath } = require('./runtime-paths');

/** 公共表只从主资源目录读取；读取/校验全部成功后加载器才更新缓存。 */
function loadSharedGameTables() {
    const tables = {};
    for (const name of ['RoleLevel', 'Plant', 'ItemInfo']) {
        const rows = JSON.parse(fs.readFileSync(getResourcePath('gameConfig', `${name}.json`), 'utf8'));
        if (!Array.isArray(rows) || rows.length === 0 || rows.some(row => !row || typeof row !== 'object')) {
            throw new Error(`${name}.json 不是有效的非空配置列表`);
        }
        const key = name === 'RoleLevel' ? 'level' : 'id';
        const ids = rows.map(row => Number(row[key]));
        if (ids.some(id => !Number.isInteger(id) || id <= 0) || new Set(ids).size !== rows.length) {
            throw new Error(`${name}.json 存在无效或重复的 ${key}`);
        }
        tables[name] = rows;
    }
    return tables;
}

module.exports = { loadSharedGameTables };
