const api = require('../../../services/friend-api');
module.exports = {
  QQ_FRIEND_LIST_BATCH_SIZE: api.QQ_FRIEND_LIST_BATCH_SIZE,
  extractReplyFriends: api.extractReplyFriends,
  fetchFriendsByGids: api.fetchFriendsByGids,
  fetchAllFriendsForScene: api.fetchAllFriendsForScene,
};
