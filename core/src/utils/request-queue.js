const { performance } = require('node:perf_hooks');
const { resolveRequestClass } = require('./request-context');

const LIMITS = { critical: 8, foreground: 60, farm: 40, friend: 30, background: 10 };
const STALL_MS = 5000;
class GatewayBusyError extends Error {
    constructor(message) { super(message); this.name = 'GatewayBusyError'; }
}

// One instance per account's connection. Encoding occupies a slot too.
class GatewayRequestQueue {
    constructor({ healthy = () => true, now = () => performance.now() } = {}) {
        this.healthy = healthy;
        this.now = now;
        this.queued = [];
        this.active = new Set();
        this.draining = false;
    }
    enqueue(execute, opts = {}) {
        const requestClass = resolveRequestClass(opts);
        if (this.queued.filter(r => r.requestClass === requestClass).length >= LIMITS[requestClass]) {
            return Promise.reject(new GatewayBusyError(`请求等待队列已满: ${requestClass}`));
        }
        return new Promise((resolve, reject) => {
            const request = { requestClass, criticalLane: opts.criticalLane || 'other',
                enqueuedAt: this.now(), startedAt: null, controller: new AbortController(), execute };
            let settled = false;
            request.finish = (error, value) => {
                if (settled) return;
                settled = true;
                clearTimeout(request.timer);
                clearTimeout(request.queueTimer);
                opts.signal?.removeEventListener('abort', abort);
                this.queued = this.queued.filter(r => r !== request);
                this.active.delete(request);
                // Remove response listeners before freeing this request's slot.
                request.controller.abort(error);
                if (error) reject(error); else resolve(value);
                this.drain();
            };
            const abort = () => request.finish(opts.signal.reason || new Error('请求已中断'));
            request.timer = setTimeout(() => request.finish(new Error(
                `请求超时: ${opts.label || requestClass} (stage=${request.startedAt !== null ? 'pending' : 'queued'})`
            )), Math.max(1, Number(opts.timeoutMs) || 20000));
            if (requestClass === 'background') {
                request.queueTimer = setTimeout(() => request.finish(new GatewayBusyError('网关繁忙，后台请求已让路 (stage=queued)')), 8000);
            }
            this.queued.push(request);
            opts.signal?.addEventListener('abort', abort, { once: true });
            if (opts.signal?.aborted) abort(); else this.drain();
        });
    }
    select() {
        const active = [...this.active];
        const critical = active.filter(r => r.requestClass === 'critical');
        for (const lane of ['heartbeat', 'ace']) {
            if (critical.some(r => r.criticalLane === lane)) continue;
            const i = this.queued.findIndex(r => r.requestClass === 'critical' && r.criticalLane === lane);
            if (i >= 0) return i;
        }
        if (critical.length < 2) {
            const i = this.queued.findIndex(r => r.requestClass === 'critical' && r.criticalLane === 'other');
            if (i >= 0) return i;
        }
        const business = active.filter(r => ['foreground', 'farm', 'friend'].includes(r.requestClass));
        const foregroundWaiting = this.queued.some(r => r.requestClass === 'foreground');
        if (business.length < 3) {
            const candidates = this.queued.map((r, i) => ({ ...r, i })).filter(r => {
                if (r.requestClass === 'foreground') return true;
                return ['farm', 'friend'].includes(r.requestClass) && !foregroundWaiting
                    && !business.some(a => a.requestClass !== 'foreground');
            });
            const starved = candidates.filter(r => this.now() - r.enqueuedAt >= 4000)
                .sort((a, b) => a.enqueuedAt - b.enqueuedAt || a.i - b.i);
            if (starved.length) return starved[0].i;
            for (const cls of ['foreground', 'farm', 'friend']) {
                const match = candidates.find(r => r.requestClass === cls);
                if (match) return match.i;
            }
        }
        if (!active.length && this.healthy() && this.queued.every(r => r.requestClass === 'background')) return 0;
        return -1;
    }
    drain() {
        if (this.draining) return;
        this.draining = true;
        try {
            let index;
            while (this.queued.length && (index = this.select()) >= 0) {
                const request = this.queued.splice(index, 1)[0];
                clearTimeout(request.queueTimer);
                request.startedAt = this.now();
                this.active.add(request);
                Promise.resolve().then(() => {
                    if (request.controller.signal.aborted) throw new Error('请求已中断');
                    return request.execute(request.controller.signal);
                }).then(value => request.finish(null, value), error => request.finish(error));
            }
        } finally { this.draining = false; }
    }
    rejectAll(reason = '请求已中断') {
        const requests = [...this.queued, ...this.active];
        // Prevent finishing one request from dispatching another during teardown.
        this.draining = true;
        try { for (const request of requests) request.finish(new Error(reason)); }
        finally { this.draining = false; }
        return requests.length;
    }
    getLoad(heartbeatMisses = 0) {
        const active = [...this.active];
        return { queued: this.queued.length, pending: active.length, heartbeatMisses,
            blockingQueued: this.queued.filter(r => r.requestClass !== 'background').length,
            businessPending: active.filter(r => ['foreground', 'farm', 'friend'].includes(r.requestClass)).length,
            backgroundPending: active.filter(r => r.requestClass === 'background').length,
            oldestPendingAgeMs: Math.max(0, ...active.map(r => this.now() - r.startedAt)) };
    }
}
function isGatewayHealthyForBusiness(load) {
    return !!load && !load.heartbeatMisses && load.oldestPendingAgeMs < STALL_MS;
}
function isGatewayIdleForBackground(load) {
    return isGatewayHealthyForBusiness(load) && !load.blockingQueued && !load.businessPending && !load.backgroundPending;
}
function isGatewayYieldError(error) {
    return error?.name === 'GatewayBusyError' || /stage=queued|连接未打开|请求已中断|尚未登录/.test(error?.message || '');
}
module.exports = { GatewayRequestQueue, GatewayBusyError, isGatewayHealthyForBusiness, isGatewayIdleForBackground, isGatewayYieldError };
