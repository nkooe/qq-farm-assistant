const test = require('node:test');
const assert = require('node:assert/strict');
const { isReleaseSourceAllowed: allowed } = require('../../scripts/release-copy-filter.cjs');

test('release retains Go QR implementation and source data, excluding only runtime roots and secrets', () => {
  for (const name of ['yyb-go/internal/qr', 'yyb-go/internal/qr/qr.go', 'yyb-go/internal/qr/qr_test.go',
    'core/src/data', 'core/src/native/parser.js', 'yyb-go/resource/templates/scan.html']) assert.equal(allowed(name), true, name);
  for (const name of ['core/data', 'core/data/accounts.json', 'core/logs/runtime.log', 'yyb-go/resource/qr/scan.png',
    'yyb-go/resource/db/accounts.json', 'yyb-go/resource/avatars/1.png', '.env', 'core/.env.local',
    'web/node_modules/a', 'core/qq-login/native/a', '.git/config', '../outside']) assert.equal(allowed(name), false, name);
});
