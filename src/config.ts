import "dotenv/config";
import { resolve } from "node:path";

export const loadConfig = {
  port: Number(process.env.PORT ?? 3000),
  whisperUrl:
    process.env.WHISPER_URL ?? "http://localhost:8080/inference",
  whisperTimeoutMs: Number(process.env.WHISPER_TIMEOUT_MS ?? 15000),
  uploadDir: resolve(process.env.UPLOAD_DIR ?? "uploads"),
  vadSilenceMs: Number(process.env.VAD_SILENCE_MS ?? 700),
  vadMinimumSpeechMs: Number(process.env.VAD_MINIMUM_SPEECH_MS ?? 250),
  vadMaximumTurnMs: Number(process.env.VAD_MAXIMUM_TURN_MS ?? 30000),
  vadThresholdRms: Number(process.env.VAD_THRESHOLD_RMS ?? 500),
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
  vadSilenceMs: number;
  vadMinimumSpeechMs: number;
  vadMaximumTurnMs: number;
  vadThresholdRms: number;
  transcriptionQueueLimit: number;
  maxWebSocketPayloadBytes: number;
  maxRecordingBytes: number;
}