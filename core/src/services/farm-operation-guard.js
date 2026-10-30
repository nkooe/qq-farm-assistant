// Each account worker owns its module instance. Reject overlapping mutations
// before reading a land snapshot so a queued operation cannot use stale state.
function createFarmOperationGuard() {
  let pending = false;
  async function run(operation) {
    if (pending) throw new Error('农场操作正在进行，请稍后再试');
    pending = true;
    try { return await operation(); }
    finally { pending = false; }
  }
  return { run, isPending: () => pending };
}

const farmOperationGuard = createFarmOperationGuard();
module.exports = { createFarmOperationGuard, farmOperationGuard };
