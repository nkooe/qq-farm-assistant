const path = require('node:path');

const runtimeRoots = [
  'data', 'logs', 'core/data', 'core/logs', 'core/qq-login/native',
  'yyb-go/resource/db', 'yyb-go/resource/qr', 'yyb-go/resource/avatars',
];
const generatedDirectories = new Set(['node_modules', '.git', 'test-results', 'playwright-report', 'coverage', '.cache']);

function isReleaseSourceAllowed(relative) {
  const name = relative.split(path.sep).join('/');
  if (name.split('/').some(part => generatedDirectories.has(part) || part === '..')) return false;
  if (runtimeRoots.some(root => name === root || name.startsWith(root + '/'))) return false;
  return !/^(\.env(?:\..*)?|.*\.(log|db|sqlite|dmp))$/i.test(path.posix.basename(name));
}

module.exports = { isReleaseSourceAllowed };
