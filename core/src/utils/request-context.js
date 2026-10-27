const { AsyncLocalStorage } = require('node:async_hooks');
const storage = new AsyncLocalStorage();
const REQUEST_CLASSES = ['critical', 'foreground', 'farm', 'friend', 'background'];

function runWithRequestClass(requestClass, fn, { signal } = {}) {
    // null explicitly clears the caller's context for infrastructure timers.
    return storage.run({ requestClass: REQUEST_CLASSES.includes(requestClass) ? requestClass : null, signal }, fn);
}
function getAmbientRequestClass() { return storage.getStore()?.requestClass || null; }
function getAmbientRequestSignal() { return storage.getStore()?.signal; }
function classForSchedulerNamespace(namespace) {
    if (['network', 'ace', 'worker_manager'].includes(namespace) || String(namespace).startsWith('ace-')) return null;
    if (['friend-pet-sync', 'milk-tea'].includes(namespace)) return 'background';
    return String(namespace).startsWith('friend') ? 'friend' : 'farm';
}
function resolveRequestClass(opts = {}, ambient = getAmbientRequestClass()) {
    if (opts.criticalLane || opts.priority === 'high') return 'critical';
    if (REQUEST_CLASSES.includes(opts.requestClass)) return opts.requestClass;
    if (opts.priority === 'low') return 'background';
    return ambient || 'foreground';
}
module.exports = { runWithRequestClass, getAmbientRequestClass, getAmbientRequestSignal, classForSchedulerNamespace, resolveRequestClass };
