import "dotenv/config";
import { resolve } from "node:path";

export const config = {
  port: Number(process.env.PORT ?? 3000),
  whisperUrl:
    process.env.WHISPER_URL ?? "http://localhost:8080/inference",
  whisperTimeoutMs: Number(process.env.WHISPER_TIMEOUT_MS ?? 15000),
  uploadDir: resolve(process.env.UPLOAD_DIR ?? "uploads"),
  audioWindowSeconds: Number(
    process.env.AUDIO_WINDOW_SECONDS ?? 3,
  ),
  transcriptionQueueLimit: Number(
    process.env.TRANSCRIPTION_QUEUE_LIMIT ?? 3,
  ),
  maxWebSocketPayloadBytes: Number(
    process.env.MAX_WEBSOCKET_PAYLOAD_BYTES ?? 256 * 1024,
  ),
  maxRecordingBytes: Number(
    process.env.MAX_RECORDING_BYTES ?? 100 * 1024 * 1024,
  ),
};

export interface AppConfig {
  port: number;
  whisperUrl: string;
  whisperTimeoutMs: number;
  uploadDir: string;
  audioWindowSeconds: number;
  transcriptionQueueLimit: number;
  maxWebSocketPayloadBytes: number;
  maxRecordingBytes: number;
}