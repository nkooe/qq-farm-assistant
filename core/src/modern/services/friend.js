const analyzer = require('../../services/friend-land-analyzer');
module.exports = {
  getFriendsList: analyzer.getFriendsList,
  getFriendsListCacheOnly: () => analyzer.getFriendsListCache() || [],
  isFriendCheckRunning: () => require('../../services/friend-orchestrator').isCheckingFriendsRunning(),
};
