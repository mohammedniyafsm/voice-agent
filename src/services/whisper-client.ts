import type { AppConfig } from "../config.js";

export type Transcriber = (
  audio: Buffer,
  streamId: string,
  sampleRate: number,
) => Promise<void>;
export type FetchLike = typeof fetch;

interface WhisperResponse {
  text: string;
}

function isWhisperResponse(value: unknown): value is WhisperResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "text" in value &&
    typeof value.text === "string"
  );
}

  export function createWhisperClient(
    config: Pick<AppConfig, "whisperUrl" | "whisperTimeoutMs">,
    fetcher: FetchLike = fetch,
  ): Transcriber {
    return async (pcm, streamId, sampleRate) => {
      const wav = createWav(pcm, sampleRate);
      const form = new FormData();

      form.append(
        "file",
        new Blob([new Uint8Array(wav)], { type: "audio/wav" }),
        "audio.wav",
      );
      form.append("response_format", "json");
      form.append("temperature", "0.0");

      console.log(`[TRANSCRIPTION] [${streamId}] started (${pcm.length} PCM bytes)`);

      const response = await fetcher(config.whisperUrl, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(config.whisperTimeoutMs),
      });

      if (!response.ok) {
        const details = (await response.text()).slice(0, 1000);
        throw new Error(`Whisper HTTP ${response.status}: ${details}`);
      }

      let result: unknown;
      try {
        result = await response.json();
      } catch (error) {
        throw new Error("Whisper returned malformed JSON.", { cause: error });
      }

      if (!isWhisperResponse(result)) {
        throw new Error("Whisper response is missing a string 'text' field.");
      }

      const text = result.text.trim();
      if (text) {
        console.log(`[TRANSCRIPTION] [${streamId}] ${text}`);
      } else {
        console.log(`[TRANSCRIPTION] [${streamId}] no speech recognized`);
      }
      console.log(`[TRANSCRIPTION] [${streamId}] completed`);
    };
  }

export function createWav(pcm: Buffer, sampleRate: number): Buffer {
  if (pcm.length % 2 !== 0) {
    throw new Error("PCM data must contain complete 16-bit samples.");
  }

  const header = Buffer.alloc(44);
  const byteRate = sampleRate * 2;

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}
