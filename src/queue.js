/**
 * In-memory FIFO job queue with concurrency = 1 and per-user anti-spam limits.
 */
export class JobQueue {
  constructor(name = "media-queue", options = {}) {
    this.name = name;
    this.maxQueueSize = options.maxQueueSize || 50;
    this.maxPerUser = options.maxPerUser || 1; // 1 active/pending job per user
    this.queue = [];
    this.activeJob = null;
  }

  get isBusy() {
    return this.activeJob !== null;
  }

  get length() {
    return this.queue.length;
  }

  /** Count active + queued jobs for a user */
  getUserJobCount(sender) {
    let count = this.activeJob && this.activeJob.sender === sender ? 1 : 0;
    for (const job of this.queue) {
      if (job.sender === sender) count++;
    }
    return count;
  }

  /** Get 1-based position for a specific user in the queue */
  getUserPosition(sender) {
    const idx = this.queue.findIndex((job) => job.sender === sender);
    return idx === -1 ? null : idx + 1;
  }

  /**
   * Enqueue a job.
   * If idle, starts immediately.
   * If busy, enqueues and notifies user of position.
   */
  async enqueue({ sender, label, run, onPosition, onStart }) {
    // 1. Anti-spam: enforce max per user
    if (this.getUserJobCount(sender) >= this.maxPerUser) {
      return {
        ok: false,
        error: "USER_LIMIT_REACHED",
        message: "⚠️ You already have a download in progress or queued. Please wait for it to complete.",
      };
    }

    // 2. Queue full protection
    if (this.queue.length >= this.maxQueueSize) {
      return {
        ok: false,
        error: "QUEUE_FULL",
        message: "⚠️ The bot queue is currently full. Please try again in a few moments.",
      };
    }

    // 3. If idle, execute immediately
    if (!this.isBusy) {
      console.log(`[${this.name}] Starting job immediately for ${sender.slice(0, 12)} (${label})`);
      this._runJob({ sender, label, run, onStart });
      return { ok: true, queued: false, position: 0 };
    }

    // 4. Otherwise, queue and notify position
    const position = this.queue.length + 1;
    console.log(`[${this.name}] Enqueuing job for ${sender.slice(0, 12)} at position #${position} (${label})`);

    const job = { sender, label, run, onPosition, onStart };
    this.queue.push(job);

    if (onPosition) {
      try {
        await onPosition(position);
      } catch (err) {
        console.error(`[${this.name}] onPosition callback error:`, err?.message || err);
      }
    }

    return { ok: true, queued: true, position };
  }

  async _runJob(job) {
    this.activeJob = job;
    try {
      if (job.onStart) {
        await job.onStart();
      }
      await job.run();
    } catch (err) {
      console.error(`[${this.name}] Error during job execution:`, err);
    } finally {
      this.activeJob = null;
      this._processNext();
    }
  }

  _processNext() {
    if (this.queue.length === 0) {
      console.log(`[${this.name}] Queue is now empty and idle.`);
      return;
    }

    const nextJob = this.queue.shift();
    console.log(`[${this.name}] Dequeued next job for ${nextJob.sender.slice(0, 12)} (${nextJob.label})`);

    // Notify any remaining queued users of their updated position
    this.queue.forEach((j, index) => {
      const newPos = index + 1;
      if (j.onPosition) {
        j.onPosition(newPos).catch(() => {});
      }
    });

    this._runJob(nextJob);
  }
}

// Global shared media processing queue (1 heavy download/upload at a time).
// NOTE: currently no bot enqueues jobs — crypto/torrent/buddy reply instantly.
// Kept as infrastructure for future bots with heavy downloads/uploads.
export const globalMediaQueue = new JobQueue("media-queue", {
  maxQueueSize: 50,
  maxPerUser: 1,
});
