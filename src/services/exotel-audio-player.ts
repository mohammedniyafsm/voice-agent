import { WebSocket } from "ws";

export interface OutboundAudioChunkerOptions {
  /**
   * Target chunk size in bytes. Exotel guidelines state:
   * - Must be a multiple of 320 bytes (16-bit 8kHz = 160 samples = 20ms chunks)
   * - Minimum 3200 bytes (~100ms) or 3200 - 6400 bytes recommended
   */
  chunkSizeBytes?: number;
  /**
   * Delay in milliseconds between consecutive chunks to simulate natural playback streaming
   */
  chunkIntervalMs?: number;
}

export class ExotelAudioPlayer {
  private currentPlayPromise?: Promise<void>;
  private isInterrupted = false;
  private isPlaying = false;

  constructor(
    private readonly socket: WebSocket,
    private readonly streamSid: string,
    private readonly options: OutboundAudioChunkerOptions = {},
  ) {}

  /**
   * Clear in-flight playback and send Exotel 'clear' control frame ONLY IF the bot is currently speaking.
   */
  interrupt(): void {
    if (!this.isPlaying) {
      return;
    }

    this.isInterrupted = true;
    this.isPlaying = false;
    if (this.socket.readyState === WebSocket.OPEN) {
      try {
        const clearMsg = JSON.stringify({
          event: "clear",
          stream_sid: this.streamSid,
        });
        this.socket.send(clearMsg);
        console.log(`[EXOTEL PLAYER] [${this.streamSid}] Sent clear frame (barge-in interruption)`);
      } catch (err) {
        console.error(`[EXOTEL PLAYER] [${this.streamSid}] Failed to send clear:`, err);
      }
    }
  }

  /**
   * Plays linear PCM audio into the active Exotel WebSocket.
   * Chunks must be multiples of 320 bytes. Default chunk: 3200 bytes (~100ms at 8kHz 16-bit mono).
   */
  async playPcm(pcm: Buffer): Promise<void> {
    this.isInterrupted = false;
    this.isPlaying = true;

    // Ensure PCM has complete 16-bit samples
    if (pcm.length % 2 !== 0) {
      pcm = pcm.subarray(0, pcm.length - 1);
    }

    const chunkSizeBytes = this.options.chunkSizeBytes ?? 3200; // 3200 bytes = 100ms at 8000Hz 16-bit mono
    const chunkIntervalMs = this.options.chunkIntervalMs ?? 90; // Stream at roughly real-time rate

    console.log(
      `[EXOTEL PLAYER] [${this.streamSid}] Playing ${pcm.length} PCM bytes (~${(
        pcm.length / 16000
      ).toFixed(2)}s) in chunks of ${chunkSizeBytes} bytes`,
    );

    try {
      let offset = 0;
      while (offset < pcm.length) {
        if (this.isInterrupted) {
          console.log(`[EXOTEL PLAYER] [${this.streamSid}] Playback stopped due to interruption.`);
          break;
        }

        if (this.socket.readyState !== WebSocket.OPEN) {
          console.log(`[EXOTEL PLAYER] [${this.streamSid}] WebSocket closed, stopping playback.`);
          break;
        }

        let end = Math.min(offset + chunkSizeBytes, pcm.length);
        let slice = pcm.subarray(offset, end);

        // Exotel requirement: each chunk byte-size must be a strict multiple of 320
        const remainder = slice.length % 320;
        if (remainder !== 0) {
          const padLength = 320 - remainder;
          slice = Buffer.concat([slice, Buffer.alloc(padLength, 0)]);
        }

        const mediaMessage = JSON.stringify({
          event: "media",
          stream_sid: this.streamSid,
          media: {
            payload: slice.toString("base64"),
          },
        });

        this.socket.send(mediaMessage);
        offset = end;

        if (offset < pcm.length) {
          await new Promise((resolve) => setTimeout(resolve, chunkIntervalMs));
        }
      }
    } finally {
      this.isPlaying = false;
    }

    console.log(`[EXOTEL PLAYER] [${this.streamSid}] Audio playback finished.`);
  }
}

