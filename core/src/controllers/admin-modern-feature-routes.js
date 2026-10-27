const { createActivityRouteContext } = require('../modern/routes/activity-center/context');
const { mountActivityCenterRoutes } = require('../modern/routes/activity-center');
const { methods } = require('../modern/feature-api');

function registerModernFeatureRoutes(context) {
  const { app, provider } = context;
  const featureProvider = Object.create(provider);
  for (const method of Object.keys(methods)) {
    featureProvider[method] = (id, ...args) => provider.featureCall(id, method, args);
  }
  const ctx = { ...context, provider: featureProvider };
  mountActivityCenterRoutes(app, ctx);
  const { withAccount } = createActivityRouteContext(app, ctx);
  const get = (path, method, args = () => []) => app.get(path, withAccount((id, req) => featureProvider[method](id, ...args(req))));
  const post = (path, method, args) => app.post(path, withAccount((id, req) => featureProvider[method](id, ...args(req))));
  get('/api/solar-calendar', 'getSolarCalendar');
  post('/api/solar-calendar/:action', 'operateSolarCalendar', req => [req.params.action, req.body]);
  get('/api/illustrated/snapshot', 'getIllustratedSnapshot');
  post('/api/illustrated/claim', 'claimIllustratedRewards', req => [req.body?.type]);
  post('/api/bag/lock', 'setItemsLocked', req => {
    if (typeof req.body?.locked !== 'boolean' || !Array.isArray(req.body?.uids) || !req.body.uids.length || req.body.uids.length > 100)
      throw new Error('请选择物品并指定锁定状态');
    return [req.body.uids, req.body.locked];
  });
  get('/api/activities/milk-tea', 'getMilkTeaActivity', req => [req.query.page || 'shop', req.query]);
  post('/api/activities/milk-tea/:action', 'operateMilkTeaActivity', req => [req.params.action, req.body]);
  get('/api/activities/share-reward/:activityId', 'getShareRewardActivity', req => [req.params.activityId]);
  post('/api/activities/share-reward/:activityId/:action', 'operateShareRewardActivity', req => [req.params.activityId, req.params.action, req.body]);
  get('/api/activities/autumn/:key', 'getAutumnActivity', req => [req.params.key]);
  post('/api/activities/autumn/:key/:action', 'operateAutumnActivity', req => [req.params.key, req.params.action, req.body]);
}
module.exports = { registerModernFeatureRoutes };
