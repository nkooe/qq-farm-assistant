const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isMainThread } = require('node:worker_threads');
// Child workers and subprocesses must keep their parent test's store.
if (isMainThread && process.argv[1]?.endsWith('.test.js')) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-test-process-'));
  process.env.FARM_DATA_DIR = directory;
  process.env.FARM_LOG_DIR = path.join(directory, 'logs');
  process.on('exit', () => fs.rmSync(directory, { recursive: true, force: true }));
}
