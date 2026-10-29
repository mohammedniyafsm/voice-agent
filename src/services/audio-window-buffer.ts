export class AudioWindowBuffer {
  private readonly chunks: Buffer[] = [];
  private chunkOffset = 0;
  private pendingBytes = 0;

  constructor(private readonly windowSize: number) {
    if (!Number.isSafeInteger(windowSize) || windowSize <= 0) {
      throw new Error("Audio window size must be a positive integer.");
    }
  }

  get bufferedBytes(): number {
    return this.pendingBytes;
  }

  push(chunk: Buffer): Buffer[] {
    if (chunk.length === 0) {
      return [];
    }

    this.chunks.push(chunk);
    this.pendingBytes += chunk.length;

    const windows: Buffer[] = [];
    while (this.pendingBytes >= this.windowSize) {
      windows.push(this.take(this.windowSize));
    }

    return windows;
  }

  flush(): Buffer | undefined {
    if (this.pendingBytes === 0) {
      return undefined;
    }

    return this.take(this.pendingBytes);
  }

  clear(): void {
    this.chunks.length = 0;
    this.chunkOffset = 0;
    this.pendingBytes = 0;
  }

  private take(length: number): Buffer {
    const result = Buffer.allocUnsafe(length);
    let written = 0;

    while (written < length) {
      const current = this.chunks[0];
      if (!current) {
        throw new Error("Audio window buffer is inconsistent.");
      }

      const available = current.length - this.chunkOffset;
      const amount = Math.min(available, length - written);

      current.copy(result, written, this.chunkOffset, this.chunkOffset + amount);
      written += amount;
      this.chunkOffset += amount;
      this.pendingBytes -= amount;

      if (this.chunkOffset === current.length) {
        this.chunks.shift();
        this.chunkOffset = 0;
      }
    }

    return result;
  }
}
