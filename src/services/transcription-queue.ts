import type { Transcriber } from "./whisper-client.js";

export class TranscriptionQueue {
  private readonly queue: Buffer[] = [];
  private running = false;
  private readonly drainWaiters: Array<() => void> = [];

  constructor(
    private readonly streamId: string,
    private readonly transcribe: Transcriber,
    private readonly capacity: number,
    private readonly sampleRate: number,
  ) {}

  enqueue(audio: Buffer): boolean {
    if (this.queue.length + Number(this.running) >= this.capacity) {
      console.error(
        `[TRANSCRIPTION] [${this.streamId}] queue full; dropping transcription window`,
      );
      return false;
    }

    this.queue.push(audio);
    void this.process();
    return true;
  }

  drain(): Promise<void> {
    if (!this.running && this.queue.length === 0) {
      return Promise.resolve();
    }

    return new Promise((resolve) => this.drainWaiters.push(resolve));
  }

  private async process(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    try {
      while (this.queue.length > 0) {
        const audio = this.queue.shift();
        if (!audio) {
          continue;
        }

        try {
          await this.transcribe(audio, this.streamId, this.sampleRate);
        } catch (error) {
          console.error(
            `[TRANSCRIPTION] [${this.streamId}] failed:`,
            error,
          );
        }
      }
    } finally {
      this.running = false;
      for (const resolve of this.drainWaiters.splice(0)) {
        resolve();
      }
      if (this.queue.length > 0) {
        void this.process();
      }
    }
  }
}
