/** Native QQ session host. Only framed events go to the owning UI's pipe. */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {pathToFileURL} from 'node:url';
import {decodeQrPicture, requestFarmCode, describeIdentity, waitForIdentity} from './qq-native-login.mjs';

const runtimeArg = process.env.FARM_QQ_RUNTIME || process.argv[2];
const dataArg = process.env.FARM_QQ_SESSION_DIR || process.argv[3];
if (!runtimeArg || !dataArg) process.exit(2);
const runtime = path.resolve(runtimeArg);
const data = path.resolve(dataArg);
const output = process.stdout.write.bind(process.stdout);
const emit = (kind, value) => output(`QQFARM_LOGIN:${  JSON.stringify({kind,value})  }\n`);
// Drop third-party log output; native console lines are ignored by the parent.
process.stdout.write = (_chunk, encoding, callback) => { (typeof encoding==='function'?encoding:callback)?.(); return true; };
process.stderr.write = process.stdout.write;
let login; let session; let confirmedUin=''; let requesting=false; let current='starting'; let shuttingDown=false; let qrVersion=0;
const labels = {
  starting:'扫码组件正在连接 QQ 服务器…', waiting_scan:'请用手机 QQ 扫码，并确认登录',
  scanned:'已扫码，请在手机 QQ 上确认登录', initializing:'已确认，正在准备取码',
  requesting:'正在获取农场 Code…', success:'已获取 Code',
  login_failed:'QQ 登录失败，请刷新二维码或切换账号重试',
  expired:'二维码已过期，请刷新', offline:'QQ 会话已断开，请切换账号重新扫码',
  error:'扫码组件遇到错误，请重新打开扫码登录'
};
function phase(value, message=labels[value], reason) {
  if (shuttingDown) return;
  current=value; emit('state',{phase:value,message:message||labels.error,canRequest:!!session&&!!confirmedUin&&!requesting&&value!=='offline',...(reason?{reason}:{})});
}
async function getCode() {
  if (!session || !confirmedUin || requesting || current==='offline' || shuttingDown) return;
  requesting=true; phase('requesting');
  try {
    const {code}=await requestFarmCode(session,{appId:'1112386029',timeoutMs:20000});
    if (shuttingDown || current==='offline') return;
    emit('code',{code});
    requesting=false; phase('success');
  } catch(error) {
    requesting=false;
    if(error.name==='QqLoginError'&&error.diagnostic)emit('diagnostic',{event:'invalid_code_result',...error.diagnostic});
    phase('error',error.name==='QqLoginError'?error.message:'QQ 原生取码调用失败，请重试');
  }
}
globalThis.__qqFarmLogin = {
  setLogin(value){login=value;},
  phase,
  loginFailed(type,code){phase(type===1&&code===3?'expired':'login_failed');},
  qr(event){
    try {
      const q=decodeQrPicture(event);
      const png=q.pngBase64QrcodeData.replace(/^data:image\/\w+;base64,/,'');
      const bytes=Buffer.from(png,'base64');
      if(bytes.length>2*1024*1024||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw new Error('Invalid QR image');
      emit('qr',{png,version:++qrVersion,receivedAt:Date.now(),expireTimeRaw:q.expireTime});
      phase('waiting_scan');
    } catch {phase('error','QQ 返回的二维码图片格式异常，请重新打开扫码登录');}
  },
  async ready(value,self){
    session=value;
    const startedAt=Date.now();
    try {
      confirmedUin=await waitForIdentity(self);
      if (shuttingDown || current==='offline') return;
      emit('diagnostic',{event:'identity_ready',...describeIdentity(self),elapsedMs:Date.now()-startedAt});
      emit('session',{uin:confirmedUin});
      await getCode();
    } catch {
      emit('diagnostic',{event:'identity_pending',...describeIdentity(self),elapsedMs:Date.now()-startedAt});
      phase('error','QQ 身份尚未就绪，稍后自动重试','identity_pending');
    }
  }
};

readline.createInterface({input:process.stdin,crlfDelay:Infinity}).on('line',line=>{
  if(line.length>4096)return;
  try {
    const {command}=JSON.parse(line);
    if(command==='shutdown'){shuttingDown=true;process.exit(0);}
    if(command==='request_code'){void getCode();}
    if(command==='refresh'&&login&&['waiting_scan','expired','login_failed'].includes(current)){
      phase('starting','正在刷新二维码…');
      if(!login.getQRCodePicture())phase('login_failed','QQ 未接受刷新请求，请稍后重试');
    }
  } catch {phase('error','扫码操作失败，请重新打开扫码登录');}
}).on('close',()=>{shuttingDown=true;process.exit(0);});

fs.mkdirSync(path.join(data,'state','config'),{recursive:true});
fs.writeFileSync(path.join(data,'state','config','napcat.json'),JSON.stringify({
  fileLog:false,consoleLog:false,autoTimeSync:false,o3HookMode:0
}));
fs.writeFileSync(path.join(data,'state','config','webui.json'),JSON.stringify({disableWebUI:true,autoLoginAccount:''}));
fs.writeFileSync(path.join(data,'state','config','plugins.json'),'{}');
Object.assign(process.env,{
  NAPCAT_WRAPPER_PATH:path.join(runtime,'wrapper.node'),
  NAPCAT_QQ_PACKAGE_INFO_PATH:path.join(runtime,'package.json'),
  NAPCAT_QQ_VERSION_CONFIG_PATH:path.join(runtime,'config.json'),
  NAPCAT_WORKDIR:path.join(data,'state'),NAPCAT_TEST_QQ_DATA:path.join(data,'qq-data'),
  NAPCAT_DISABLE_PIPE:'1',NAPCAT_DISABLE_MULTI_PROCESS:'1',NAPCAT_DISABLE_BYPASS:'1',NAPCAT_DISABLE_TIME_SYNC:'1'
});
// The parent explicitly supplies an optional SOCKS5 proxy; no machine-specific port.
for(const key of Object.keys(process.env)){
  if(key.startsWith('NAPCAT_QUICK_')||key==='NAPCAT_MAIN_PATH')delete process.env[key];
}
phase('starting');
const restoreUin = process.env.FARM_QQ_RESTORE_UIN || '';
if (/^\d{5,20}$/.test(restoreUin)) process.argv.push('-q', restoreUin);
void import(pathToFileURL(path.join(runtime,'napcat','napcat.mjs')).href)
  .catch(() => phase('error','扫码组件加载失败，请重新解压完整发布包后重试'));
