export interface AlertJob {
  groupId: number;
  run: () => Promise<void>;
}

interface AlertQueueOptions {
  maxPerSecond: number; // global limit
  maxInFlight: number;  // concurrent send limit
}

export class AlertQueue {
  private jobs: AlertJob[] = [];
  private inFlight = 0;
  private readonly maxPerSecond: number;
  private readonly maxInFlight: number;
  private readonly sentTimestamps: number[] = [];

  // NEW: hard cap to prevent unbounded growth
  private readonly MAX_QUEUE_SIZE = 5000;

  private timer: NodeJS.Timeout;

  constructor(opts: AlertQueueOptions) {
    this.maxPerSecond = opts.maxPerSecond;
    this.maxInFlight = opts.maxInFlight;
    this.timer = setInterval(() => this.tick(), 100); // 10x/sec
  }

  enqueue(job: AlertJob) {
    // NEW: drop oldest if queue is too big
    if (this.jobs.length >= this.MAX_QUEUE_SIZE) {
      this.jobs.shift(); // drop oldest
      console.warn(
        `[AlertQueue] Overflow – dropped oldest job, size now ${this.jobs.length}`
      );
    }

    // existing logic unchanged
    this.jobs.push(job);
  }

  private canSendNow(now: number): boolean {
    // drop >1s old timestamps
    while (this.sentTimestamps.length && now - this.sentTimestamps[0] > 1000) {
      this.sentTimestamps.shift();
    }
    return this.sentTimestamps.length < this.maxPerSecond;
  }

  private tick() {
    const now = Date.now();
    if (!this.jobs.length) return;
    if (this.inFlight >= this.maxInFlight) return;
    if (!this.canSendNow(now)) return;

    const job = this.jobs.shift();
    if (!job) return;

    this.inFlight++;
    this.sentTimestamps.push(now);

    job
      .run()
      .catch((e) => {
        console.error("Alert job failed:", e);
      })
      .finally(() => {
        this.inFlight--;
      });
  }

  stop() {
    clearInterval(this.timer);
  }
}

export const globalAlertQueue = new AlertQueue({
  maxPerSecond: 25, // Telegram global ~30/sec, safe side
  maxInFlight: 4
});
