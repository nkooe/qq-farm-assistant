const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { threadId } = require('node:worker_threads');

// Identity mutations run synchronously in the Node controller. An undo journal
// makes users, cards and claim records one durable operation across restarts.
function createIdentityTransaction(directory) {
    const allowed = new Set(['users.json', 'cards.json', 'card-claim.json']);
    const journal = path.join(directory, '.identity-transaction.json');
    let active = false;

    function syncDirectory() {
        // Windows does not expose directory fsync through Node. File fsync and
        // atomic rename still apply; Linux deployment also flushes directory entries.
        if (process.platform === 'win32') return;
        const fd = fs.openSync(directory, 'r');
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }

    function read(file) {
        try { return fs.readFileSync(file, 'utf8'); }
        catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    }

    function write(file, content) {
        const temp = `${file}.${crypto.randomBytes(12).toString('hex')}.tmp`;
        try {
            const fd = fs.openSync(temp, 'wx', 0o600);
            try { fs.writeFileSync(fd, content, 'utf8'); fs.fsyncSync(fd); }
            finally { fs.closeSync(fd); }
            fs.renameSync(temp, file);
            syncDirectory();
        } finally {
            if (fs.existsSync(temp)) fs.unlinkSync(temp);
        }
    }

    function restore(data) {
        for (const entry of data.entries) {
            const file = path.join(directory, entry.name);
            if (read(file) === entry.before) continue;
            if (entry.before === null) { fs.unlinkSync(file); syncDirectory(); }
            else write(file, entry.before);
        }
        fs.unlinkSync(journal);
        syncDirectory();
    }

    function recover() {
        if (active || !fs.existsSync(journal)) return;
        let data;
        try { data = JSON.parse(fs.readFileSync(journal, 'utf8')); }
        catch (cause) { throw new Error('用户事务日志无效，请检查数据存储', { cause }); }
        if (data?.version !== 1 || !Number.isSafeInteger(data.pid) || data.pid <= 0
            || !Number.isSafeInteger(data.threadId) || data.threadId < 0
            || !Array.isArray(data.entries) || data.entries.length < 1 || data.entries.length > allowed.size
            || data.entries.some(entry => !entry || !allowed.has(entry.name) || (entry.before !== null && typeof entry.before !== 'string'))
            || new Set(data.entries.map(entry => entry.name)).size !== data.entries.length) {
            throw new Error('用户事务日志无效，请检查数据存储');
        }
        if (data.pid !== process.pid || data.threadId !== threadId) {
            try { process.kill(data.pid, 0); }
            catch (error) { if (error.code !== 'ESRCH') throw error; return restore(data); }
            throw new Error('用户数据事务正在写入，请稍后重试');
        }
        restore(data);
    }

    function commit(values) {
        if (active) throw new Error('用户事务禁止嵌套');
        recover();
        const names = Object.keys(values);
        if (!names.length || names.some(name => !allowed.has(name))) throw new Error('用户事务文件无效');
        fs.mkdirSync(directory, { recursive: true });
        const data = { version: 1, pid: process.pid, threadId, entries: names.map(name => ({ name, before: read(path.join(directory, name)) })) };
        const contents = names.map(name => JSON.stringify(values[name], null, 2));
        // Exclusive creation prevents competing writers from replacing the undo log.
        const fd = fs.openSync(journal, 'wx', 0o600);
        active = true;
        try {
            try { fs.writeFileSync(fd, JSON.stringify(data), 'utf8'); fs.fsyncSync(fd); }
            finally { fs.closeSync(fd); }
            syncDirectory();
            for (let i = 0; i < names.length; i++) write(path.join(directory, names[i]), contents[i]);
            fs.unlinkSync(journal);
            syncDirectory();
        } catch (error) {
            // A failed restore retains the journal. Every later read must recover
            // it successfully before serving identity data.
            try { restore(data); }
            catch (recoveryError) { throw new AggregateError([error, recoveryError], '用户事务保存及恢复失败，请检查数据存储'); }
            throw error;
        } finally { active = false; }
    }

    return { recover, commit };
}

module.exports = { createIdentityTransaction };
