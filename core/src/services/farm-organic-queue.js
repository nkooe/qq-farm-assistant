const SLICE_OPERATIONS = 4;
const MAX_OPERATIONS = 240;
const MAX_LAND_OPERATIONS = 20;

// One queue per account worker. Each continuation reacquires the account lock
// and a fresh land snapshot; uncertain writes are never retried in this cycle.
function createOrganicFertilizerQueue({ scheduler, runExclusive, prepare, send, delay, onProgress, onError }) {
  let current = null;

  function cancel(job) {
    if (current !== job) return;
    current = null;
    scheduler.clear('continue');
  }
  function schedule(job) {
    if (current !== job) return;
    if (!job.allowed() || job.total >= job.limit || !job.lands.size) { cancel(job); return; }
    scheduler.setTimeoutTask('continue', 1500, async () => {
      if (current !== job) return;
      try {
        await runExclusive(() => drain(job));
      } catch (error) {
        cancel(job);
        onError(error);
      } finally { schedule(job); }
    });
  }
  async function drain(job, prepared) {
    if (current !== job || !job.allowed()) { cancel(job); return 0; }
    let count = 0;
    try {
      const eligible = prepared || await prepare([...job.lands.keys()]);
      if (!job.allowed()) { cancel(job); return 0; }
      for (const [id, land] of job.lands) {
        const identity = eligible.get(id);
        if (identity === undefined || (land.identity !== null && land.identity !== identity)) job.lands.delete(id);
        else land.identity = identity;
      }
      while (count < SLICE_OPERATIONS && job.total < job.limit && job.lands.size && job.allowed()) {
        const [id, land] = job.lands.entries().next().value;
        await send(id, () => current === job && job.allowed());
        count++;
        job.total++;
        land.count++;
        job.lands.delete(id);
        if (land.count < MAX_LAND_OPERATIONS) job.lands.set(id, land);
        if (count < SLICE_OPERATIONS && job.total < job.limit && job.lands.size && job.allowed()) await delay(1000, 1500);
      }
      return count;
    } catch (error) {
      cancel(job);
      throw error;
    } finally {
      if (count) onProgress(count);
    }
  }
  return {
    async enqueue(ids, allowed) {
      if (!allowed()) return 0;
      const eligible = await prepare(ids);
      if (!allowed() || !eligible.size) return 0;
      if (current && !current.allowed()) cancel(current);
      const fresh = !current;
      const job = current || (current = { lands: new Map(), seen: new Set(), total: 0, limit: 0, allowed });
      for (const id of ids) {
        const identity = eligible.get(id);
        if (identity === undefined) continue;
        const key = JSON.stringify([id, identity]);
        if (job.seen.has(key)) continue;
        job.seen.add(key);
        job.lands.set(id, { identity, count: 0 });
      }
      job.limit = Math.min(MAX_OPERATIONS, job.seen.size * MAX_LAND_OPERATIONS);
      if (!fresh) return 0;
      try { return await drain(job, eligible); }
      finally { schedule(job); }
    },
  };
}

module.exports = { createOrganicFertilizerQueue };
