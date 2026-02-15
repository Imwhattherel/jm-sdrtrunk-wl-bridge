export class TxQueue {
  constructor() {
    this.queue = [];
    this.running = false;
  }

  enqueue(job) {
    this.queue.push(job);
    this.#kick();
  }

  async #kick() {
    if (this.running) return;
    this.running = true;

    try {
      while (this.queue.length) {
        const job = this.queue.shift();
        await job();
      }
    } finally {
      this.running = false;
    }
  }
}
