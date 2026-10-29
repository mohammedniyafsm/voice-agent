import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { finished } from "node:stream/promises";
import type { WriteStream } from "node:fs";

export class AudioRecorder {
  readonly filePath: string;
  private readonly stream: WriteStream;
  private failure: Error | undefined;
  private recordedBytes = 0;
  private finalized = false;
  private finishPromise: Promise<void> | undefined;

  constructor(
    uploadDir: string,
    readonly maxBytes: number,
  ) {
    mkdirSync(uploadDir, { recursive: true });
    this.filePath = join(uploadDir, `${randomUUID()}.pcm`);
    this.stream = createWriteStream(this.filePath, { flags: "wx" });
    this.stream.on("error", (error) => {
      this.failure = error;
    });
  }

  write(chunk: Buffer): boolean {
    if (this.finalized) {
      throw new Error("Cannot write to a finalized recording.");
    }
    if (this.failure) {
      throw this.failure;
    }
    if (this.recordedBytes + chunk.length > this.maxBytes) {
      throw new Error(`Recording size limit of ${this.maxBytes} bytes exceeded.`);
    }

    this.recordedBytes += chunk.length;
    return this.stream.write(chunk);
  }

  onceDrain(callback: () => void): void {
    this.stream.once("drain", callback);
  }

  onError(callback: (error: Error) => void): void {
    this.stream.on("error", callback);
  }

  finish(): Promise<void> {
    if (this.finishPromise) {
      return this.finishPromise;
    }

    this.finalized = true;
    this.stream.end();
    this.finishPromise = finished(this.stream).then(() => {
      if (this.failure) {
        throw this.failure;
      }
    });

    return this.finishPromise;
  }
}
