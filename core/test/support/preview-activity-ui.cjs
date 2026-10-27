// Local UI fixture server. No user data, credentials, game connections or real writes.
const express = require('express');
const path = require('node:path');
const app = express();
app.use(express.json());
const now = Math.floor(Date.now() / 1000);
const { buildActivityDirectory } = require('../../src/modern/services/activity-center');
const windows = [['2026072700', '千星游记'], ['2026072701', '观星礼录'], ['2026070300', '雨落成诗'],
  ['2026081800', '鹊桥寄情'], ['2026090900', '公益小红花'], ['2026090100', '萌宠日记'],
  ['2026092400', '秋祈良愿'], ['2026110100', '来杯奶茶'], ['2026110104', '快乐不独享']]
  .map(([id, name]) => ({ id, name, beginTime: now - 86400, endTime: now + 864000 }));
const states = new Map();
function calendar(id) {
  if (!states.has(id)) states.set(id, { serverTime: now, defaultEventId: 401,
    events: [{ id: 401, name: id === 'ui-B' ? '测试账号 B 的重阳' : '重阳', description: '农历九月初九，登高赏秋。',
      startTime: now - 86400, endTime: now + 864000, status: 2, directClaimed: false, quizClaimed: false,
      quizWrongToday: false, wrongOptions: [], question: '重阳节又被称为什么节？', options: ['A.敬老节', 'B.儿童节', 'C.母亲节', 'D.教师节'],
      rules: ['请按服务器活动时间参与。'], rewards: [{id:1001, count:200, name:'金币'}], questionRewards:[{id:1001,count:100,name:'金币'}], canClaim: true, canAnswer: true }],
    seasons:[{ id:4, name:'秋季', year:'2026', description:'测试季度', eventIds:[401],litCount:0,totalCount:1,claimed:false,canClaim:false,rewards:[] }] });
  return structuredClone(states.get(id));
}
app.post('/api/auto-login', (_req, res) => res.json({ok:true,data:{token:'local-ui-fixture'}}));
app.get('/api/auth/validate', (_req, res) => res.json({ok:true}));
app.get('/api/user/me', (_req, res) => res.json({ok:true,data:{username:'界面测试',role:'admin',card:null,accountLimit:2}}));
app.get('/api/accounts', (_req, res) => res.json({ok:true,data:{accounts:['A','B'].map(name=>({id:`ui-${name}`,name:`界面测试 ${name}`,running:true,connected:true,runtimeState:'online',platform:'wx'}))}}));
app.get('/api/activity-center/activities', (_req,res)=>res.json({ok:true,data:{serverTime:now,activities:buildActivityDirectory(windows,null,null,null,null)}}));
app.get('/api/solar-calendar', (req,res)=>res.json({ok:true,data:calendar(req.get('x-account-id'))}));
app.post('/api/solar-calendar/:action', (req,res)=>{
  const id=req.get('x-account-id'); const data=calendar(id); const event=data.events[0];
  const action=req.params.action;
  if(action==='claim'){event.directClaimed=true;event.canClaim=false;}
  if(action==='answer'){event.quizClaimed=req.body.optionIndex===0;event.quizWrongToday=!event.quizClaimed;event.canAnswer=false;}
  states.set(id,data);
  res.json({ok:true,data:{calendar:data,rewards:[{id:1001,count:100,name:'测试金币'}],correct:event.quizClaimed}});
});
app.use('/game-config',express.static(path.resolve(__dirname,'../../src/modern/gameConfig')));
app.use('/api',(_req,res)=>res.json({ok:false,error:'界面测试不连接真实游戏；此接口未提供测试数据'}));
app.use(express.static(path.resolve(__dirname,'../../../web/dist')));
app.get('*',(_req,res)=>res.sendFile(path.resolve(__dirname,'../../../web/dist/index.html')));
const server=app.listen(4190,'127.0.0.1',()=>console.log('UI fixtures: http://127.0.0.1:4190/activity (loopback only)'));
process.on('SIGTERM',()=>server.close());
