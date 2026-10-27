// Explicit RPC allowlist shared by worker dispatch and the authorized HTTP routes.
const groups = {
  'activity-center': ['getActivityDirectorySnapshot', 'getActivityCenterSnapshot', 'getCurrentSeasonEvent',
    'getCurrentStellarActivity', 'getCurrentStarSandShop', 'getCurrentSolarTerms', 'getCurrentQixiActivity',
    'getCurrentQingMeiActivity', 'getCurrentCharityRedFlowerActivity', 'getCurrentWeatherActivity',
    'getWeatherFriends', 'claimBattlePassRewards', 'lightConstellation', 'exchangeStarSandGoods', 'claimSolarTerm',
    'claimQixiBridgeRewards', 'giftQixiSachet', 'claimQingMeiDailySeed', 'startQingMeiBrew', 'continueQingMeiBrew',
    'settleQingMeiBrew', 'claimCharityRedFlowerSeeds', 'donateCharityRedFlowerLove',
    'claimCharityRedFlowerDailyGift', 'claimCharityRedFlowerProgressReward', 'getPetDiary', 'getPetDiaryRecords',
    'getPetDiaryFriend', 'operatePetDiary', 'lightWeatherResearch', 'buyWeatherBottle', 'collectWeatherBottle',
    'summonWeatherRain', 'exchangeWeatherCollectorBottle', 'scanWeatherFriends', 'useWeatherCollectorBottle',
    'useWeatherSummonBottle', 'useWeatherFrogBottle', 'useWeatherCloudBottle', 'advanceWeatherResearch'],
  'solar-calendar': ['getSolarCalendar', 'operateSolarCalendar'],
  'milk-tea': ['getMilkTeaActivity', 'operateMilkTeaActivity'],
  'share-reward-activity': ['getShareRewardActivity', 'operateShareRewardActivity'],
  'autumn-activities': ['getAutumnActivity', 'operateAutumnActivity'],
  'illustrated': ['getIllustratedSnapshot', 'claimIllustratedRewards'],
  'warehouse': ['setItemsLocked'],
};
const methods = Object.freeze(Object.fromEntries(Object.entries(groups).flatMap(([service, names]) => names.map(name => [name, service]))));
async function callFeature(method, args = []) {
  if (!Object.hasOwn(methods, method)) throw new Error('未知的活动操作');
  if (!Array.isArray(args)) throw new Error('操作参数无效');
  return require(`./services/${methods[method]}`)[method](...args);
}
module.exports = { methods, callFeature };
