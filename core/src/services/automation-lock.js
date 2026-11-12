const { AsyncLocalStorage } = require('node:async_hooks');
const storage = new AsyncLocalStorage();
let tail = Promise.resolve();
let running = false;
function runExclusiveAutomationTask(taskName, taskFn, options = {}) {
    const store = storage.getStore();
    if (!options.detached && store && store.exclusive && store.active)
        return Promise.resolve(taskFn());
    const run = tail.then(async () => {
        running = true;
        const taskStore = { exclusive: true, active: true };
        try {
            return await storage.run(taskStore, taskFn);
        }
        finally {
            taskStore.active = false;
            running = false;
        }
    });
    tail = run.then(() => undefined, () => undefined);
    return run;
}
function isAutomationTaskRunning() {
    return running;
}
module.exports = {
    runExclusiveAutomationTask,
    isAutomationTaskRunning,
};
