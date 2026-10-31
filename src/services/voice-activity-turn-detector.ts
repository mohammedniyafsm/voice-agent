export interface VoiceActivityTurnDetectorOptions {
  sampleRate: number;
  silenceMs: number;
  minimumSpeechMs: number;
  maximumTurnMs: number;
  thresholdRms: number;
  onTurnComplete: (audio: Buffer) => void;
  onSpeechStart?: () => void;
}

export class VoiceActivityTurnDetector {
  private readonly frameBytes: number;
  private readonly sampleRate: number;
  private readonly pendingChunks: Buffer[] = [];
  private pendingBytes = 0;
  private candidateFrames: Buffer[] = [];
  private voicedMs = 0;
  private candidateDurationMs = 0;
  private turnFrames: Buffer[] = [];
  private trailingSilenceFrames = 0;
  private trailingSilenceMs = 0;
  private turnDurationMs = 0;

  constructor(private readonly options: VoiceActivityTurnDetectorOptions) {
    const {
      sampleRate,
      silenceMs,
      minimumSpeechMs,
      maximumTurnMs,
      thresholdRms,
    } = options;
    if (
      !Number.isSafeInteger(sampleRate) ||
      sampleRate <= 0 ||
      !Number.isSafeInteger(silenceMs) ||
      silenceMs <= 0 ||
      !Number.isSafeInteger(minimumSpeechMs) ||
      minimumSpeechMs <= 0 ||
      !Number.isSafeInteger(maximumTurnMs) ||
      maximumTurnMs <= 0 ||
      !Number.isFinite(thresholdRms) ||
      thresholdRms <= 0
    ) {
      throw new Error("Invalid voice activity detection settings.");
    }

    this.sampleRate = sampleRate;
    this.frameBytes = (sampleRate / 50) * 2;
    if (!Number.isSafeInteger(this.frameBytes)) {
      throw new Error("Sample rate cannot produce 20 ms PCM frames.");
    }
  }

  push(audio: Buffer): void {
    if (audio.length === 0) {
      return;
    }
    if (audio.length % 2 !== 0) {
      throw new Error("PCM data must contain complete 16-bit samples.");
    }

    this.pendingChunks.push(audio);
    this.pendingBytes += audio.length;
    while (this.pendingBytes >= this.frameBytes) {
      this.processFrame(this.takeFrame(this.frameBytes));
    }
  }

  flush(): void {
    if (this.pendingBytes > 0) {
      this.processFrame(this.takeFrame(this.pendingBytes));
    }
    if (this.turnFrames.length > 0) {
      this.finishTurn();
    } else {
      this.resetCandidate();
    }
  }

  clear(): void {
    this.pendingChunks.length = 0;
    this.pendingBytes = 0;
    this.turnFrames = [];
    this.trailingSilenceFrames = 0;
    this.trailingSilenceMs = 0;
    this.turnDurationMs = 0;
    this.resetCandidate();
  }

  private processFrame(frame: Buffer): void {
    const isVoiced = this.rms(frame) >= this.options.thresholdRms;
    const frameDurationMs = (frame.length / 2 / this.sampleRate) * 1000;

    if (this.turnFrames.length === 0) {
      if (isVoiced) {
        this.candidateFrames.push(frame);
        this.voicedMs += frameDurationMs;
        this.candidateDurationMs += frameDurationMs;
        if (this.voicedMs >= this.options.minimumSpeechMs) {
          this.turnFrames = this.candidateFrames;
          this.candidateFrames = [];
          this.voicedMs = 0;
          this.turnDurationMs = this.candidateDurationMs;
          this.candidateDurationMs = 0;
          this.trailingSilenceFrames = 0;
          this.trailingSilenceMs = 0;
          this.options.onSpeechStart?.();
        }
      } else {
        this.resetCandidate();
      }
      return;
    }

    this.turnFrames.push(frame);
    this.turnDurationMs += frameDurationMs;
    if (isVoiced) {
      this.trailingSilenceFrames = 0;
      this.trailingSilenceMs = 0;
    } else {
      this.trailingSilenceFrames += 1;
      this.trailingSilenceMs += frameDurationMs;
      if (this.trailingSilenceMs >= this.options.silenceMs) {
        this.finishTurn();
        return;
      }
    }

    if (this.turnDurationMs >= this.options.maximumTurnMs) {
      this.finishTurn();
    }
  }

  private finishTurn(): void {
    const speechFrameCount = this.turnFrames.length - this.trailingSilenceFrames;
    const audio = Buffer.concat(this.turnFrames.slice(0, speechFrameCount));
    this.turnFrames = [];
    this.trailingSilenceFrames = 0;
    this.trailingSilenceMs = 0;
    this.turnDurationMs = 0;
    this.resetCandidate();
    if (audio.length > 0) {
      this.options.onTurnComplete(audio);
    }
  }

  private resetCandidate(): void {
    this.candidateFrames = [];
    this.voicedMs = 0;
    this.candidateDurationMs = 0;
  }

  private rms(frame: Buffer): number {
    let sumSquares = 0;
    const sampleCount = Math.floor(frame.length / 2);
    for (let offset = 0; offset + 1 < frame.length; offset += 2) {
      const sample = frame.readInt16LE(offset);
      sumSquares += sample * sample;
    }
    return sampleCount === 0 ? 0 : Math.sqrt(sumSquares / sampleCount);
  }

  private takeFrame(length: number): Buffer {
    const frame = Buffer.allocUnsafe(length);
    let written = 0;
    while (written < length) {
      const chunk = this.pendingChunks[0];
      if (!chunk) {
        throw new Error("Voice activity frame buffer is inconsistent.");
      }
      const amount = Math.min(chunk.length, length - written);
      chunk.copy(frame, written, 0, amount);
      written += amount;
      this.pendingBytes -= amount;
      if (amount === chunk.length) {
        this.pendingChunks.shift();
      } else {
        this.pendingChunks[0] = chunk.subarray(amount);
      }
    }
    return frame;
  }
}
