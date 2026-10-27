"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createActivityRouteContext = createActivityRouteContext;
const error_handler_1 = require("./error-handler");
const { getAuthorizedAccountId, requireConnectedAccount } = require('../../../controllers/admin-activity-route-helpers');
function createActivityRouteContext(app, ctx) {
    const withAccount = (handler) => async (req, res) => {
        const accountId = getAuthorizedAccountId(req, res, ctx);
        if (!accountId) return;
        if (!requireConnectedAccount(res, ctx.provider, accountId, '当前账号未连接，请启动账号后重试')) return;
        try {
            const data = await handler(accountId, req, res);
            if (!res.headersSent)
                return res.json({ ok: true, data });
            return undefined;
        }
        catch (error) {
            return (0, error_handler_1.handleActivityApiError)(res, error);
        }
    };
    const mountGet = (path, providerMethod) => {
        app.get(path, withAccount((accountId) => ctx.provider[providerMethod](accountId)));
    };
    return { app, ctx, withAccount, mountGet };
}
