// Docker's isolated QQ application uses this entry instead of the QQ UI.
const path = require('node:path');
const fs = require('node:fs');
const {pathToFileURL} = require('node:url');
const {app} = require('electron');
if (!process.env.FARM_QQ_HOST || !process.env.FARM_QQ_SESSION_DIR) process.exit(2);
const userData = path.join(process.env.FARM_QQ_SESSION_DIR,'electron');
fs.mkdirSync(userData, {recursive: true});
app.setPath('userData',userData);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-dev-shm-usage');
app.whenReady().then(()=>import(pathToFileURL(process.env.FARM_QQ_HOST).href)).catch(()=>process.exit(1));
app.on('window-all-closed',()=>{});
