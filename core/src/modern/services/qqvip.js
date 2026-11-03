const { types } = require('../utils/proto');
const { sendMsgAsync } = require('../utils/network');

async function getQQVipRewardsStatus() {
  const request = types.GetQQVipRewardsStatusRequest.encode({}).finish();
  const { body } = await sendMsgAsync('gamepb.qqvippb.QQVipService', 'GetQQVipRewardsStatus', request);
  return types.GetQQVipRewardsStatusReply.decode(body);
}

module.exports = { getQQVipRewardsStatus };
