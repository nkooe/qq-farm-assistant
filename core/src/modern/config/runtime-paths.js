const path = require('node:path');
const paths = require('../../config/runtime-paths');
module.exports = { ...paths, getResourcePath: (...parts) => path.join(__dirname, '..', ...parts) };
