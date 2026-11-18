'use strict';

// 小果 is the farm guide NPC, not a player with a ranch. Identify it by
// its fixed GID so real players with the same display name remain available.
function isFarmOnlyFriend(gid) {
    return String(gid) === '10001';
}

module.exports = { isFarmOnlyFriend };
