import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import express from "express";
import { WebSocket, WebSocketServer } from "ws";
import type { IncomingMessage } from "node:http";
import type { AppConfig } from "../config.js";
import { AudioRecorder } from "../services/audio-recorder.js";
import { AudioWindowBuffer } from "../services/audio-window-buffer.js";
import { createWhisperClient } from "../services/whisper-client.js";
import type { Transcriber } from "../services/whisper-client.js";
import { TranscriptionQueue } from "../services/transcription-queue.js";
import type { ExotelMediaFormat } from "../types/exotel.js";
import { isExotelEvent, isRecord } from "../types/exotel.js";

const SAMPLE_RATES = new Set([8000, 16000, 24000]);
const PCM_BYTES_PER_SAMPLE = 2;
const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?$/;

interface AudioFormat {
  sampleRate: number;
  windowSizeBytes: number;
}

function readPositiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error(`${name} must be a positive integer.`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function validateAudioFormat(
  mediaFormat: ExotelMediaFormat | undefined,
  requestedRate: number,
  windowSeconds: number,
): AudioFormat {
  const encoding = mediaFormat?.encoding;
  if (
    encoding !== undefined &&
    (typeof encoding !== "string" ||
      !["raw", "slin", "audio/pcm"].includes(encoding.toLowerCase()))
  ) {
    throw new Error(`Unsupported Exotel audio encoding: ${String(encoding)}`);
  }

  const sampleRate =
    readPositiveInteger(mediaFormat?.sample_rate, "sample_rate") ??
    requestedRate;
  if (!SAMPLE_RATES.has(sampleRate)) {
    throw new Error(`Unsupported Exotel sample rate: ${sampleRate}`);
  }

  const channels = readPositiveInteger(
    mediaFormat?.channels ?? mediaFormat?.channel_count,
    "channels",
  );
  if (channels !== undefined && channels !== 1) {
    throw new Error(`Expected mono audio, received ${channels} channels.`);
  }

  const bitsPerSample = readPositiveInteger(
    mediaFormat?.bits_per_sample,
    "bits_per_sample",
  );
  if (bitsPerSample !== undefined && bitsPerSample !== 16) {
    throw new Error(`Expected 16-bit PCM, received ${bitsPerSample} bits.`);
  }

  const sampleWidth = readPositiveInteger(
    mediaFormat?.sample_width,
    "sample_width",
  );
  if (sampleWidth !== undefined && sampleWidth !== PCM_BYTES_PER_SAMPLE) {
    throw new Error(
      `Expected 2-byte PCM samples, received ${sampleWidth} bytes.`,
    );
  }

  const windowSizeBytes = Math.round(
    sampleRate * PCM_BYTES_PER_SAMPLE * windowSeconds,
  );
  if (!Number.isSafeInteger(windowSizeBytes) || windowSizeBytes <= 0) {
    throw new Error("Configured audio window size is invalid.");
  }

  return { sampleRate, windowSizeBytes };
}

function requestedSampleRate(request: IncomingMessage): number {
  const requestUrl = new URL(request.url ?? "/", "http://localhost");
  const value = requestUrl.searchParams.get("sample-rate");

  if (value === null) {
    return 8000;
  }

  const rate = readPositiveInteger(value, "sample-rate");
  if (!rate || !SAMPLE_RATES.has(rate)) {
    throw new Error("sample-rate must be 8000, 16000, or 24000.");
  }

  return rate;
}

function decodePayload(value: unknown): Buffer | undefined {
  if (typeof value !== "string" || !BASE64_PATTERN.test(value)) {
    return undefined;
  }

  const audio = Buffer.from(value, "base64");
  if (audio.length === 0 || audio.length % PCM_BYTES_PER_SAMPLE !== 0) {
    return undefined;
  }

  return audio;
}

export function createMediaServer(
  config: AppConfig,
  transcribe: Transcriber = createWhisperClient(config),
) {


  const app = express();

  app.get("/health", (_request, response) => {
    response.json({ status: "ok", service: "voice-agent" });
  });

  const server = createServer(app);
  const websocketServer = new WebSocketServer({
    server,
    path: "/media",
    maxPayload: config.maxWebSocketPayloadBytes,
    perMessageDeflate: false,
  });

  websocketServer.on("connection", (socket, request) => {
    handleConnection(socket, request, config, transcribe);
  });

  websocketServer.on("error", (error) => {
    console.error("[WS] server error:", error);
  });

  return { server, websocketServer };
}

function handleConnection(
  socket: WebSocket,
  request: IncomingMessage,
  config: AppConfig,
  transcribe: Transcriber,
): void {
  const streamId = randomUUID();
  let rateFromUrl: number;

  try {
    rateFromUrl = requestedSampleRate(request);
  } catch (error) {
    console.error(`[WS] [${streamId}] invalid stream URL:`, error);
    socket.close(1008, "Invalid sample-rate configuration");
    return;
  }

  let recorder: AudioRecorder;
  try {
    recorder = new AudioRecorder(config.uploadDir, config.maxRecordingBytes);
  } catch (error) {
    console.error(`[RECORDING] [${streamId}] could not create recording:`, error);
    socket.close(1011, "Recording could not be created");
    return;
  }

  let format: AudioFormat | undefined;
  let windows: AudioWindowBuffer | undefined;
  let queue: TranscriptionQueue | undefined;
  let recordingBytes = 0;
  let closed = false;
  let finishPromise: Promise<void> | undefined;

  console.log(`[WS] [${streamId}] client connected`);
  console.log(`[RECORDING] [${streamId}] file created: ${recorder.filePath}`);

  recorder.onError((error) => {
    console.error(`[RECORDING] [${streamId}] write failed:`, error);
    if (socket.readyState === WebSocket.OPEN) {
      socket.close(1011, "Recording failed");
    }
  });

  socket.on("message", (rawMessage, isBinary) => {
    if (closed) {
      return;
    }

    if (isBinary) {
      console.error(`[WS] [${streamId}] binary messages are not supported`);
      return;
    }

    let event: unknown;
    try {
      event = JSON.parse(rawMessage.toString());
    } catch (error) {
      console.error(`[WS] [${streamId}] invalid JSON:`, error);
      return;
    }

    if (!isExotelEvent(event)) {
      console.error(`[WS] [${streamId}] invalid event: event name missing`);
      return;
    }

    switch (event.event) {
      case "connected":
        console.log(`[WS] [${streamId}] Exotel stream connected`);
        break;

      case "start": {
        if (format) {
          console.error(`[STREAM] [${streamId}] duplicate start event`);
          socket.close(1008, "Duplicate start event");
          break;
        }

        const start = isRecord(event.start) ? event.start : {};
        const mediaFormat: ExotelMediaFormat | undefined = isRecord(start.media_format)
          ? start.media_format
          : undefined;

        try {
          format = validateAudioFormat(
            mediaFormat,
            rateFromUrl,
            config.audioWindowSeconds,
          );
          windows = new AudioWindowBuffer(format.windowSizeBytes);
          queue = new TranscriptionQueue(
            streamId,
            transcribe,
            config.transcriptionQueueLimit,
            format.sampleRate,
          );
          console.log(
            `[STREAM] [${streamId}] started; encoding=${mediaFormat?.encoding ?? "documented raw/slin PCM"}, sample_rate=${format.sampleRate}, channels=1, bits_per_sample=16`,
          );
        } catch (error) {
          console.error(`[STREAM] [${streamId}] unsupported audio format:`, error);
          socket.close(1003, "Unsupported audio format");
        }
        break;
      }

      case "media": {
        if (!recorder || !queue || !windows || !format) {
          console.error(`[WS] [${streamId}] media received before valid start event`);
          break;
        }

        const media = isRecord(event.media) ? event.media : {};
        const audio = decodePayload(media.payload);
        if (!audio) {
          console.error(`[AUDIO] [${streamId}] invalid Base64 PCM payload`);
          break;
        }
        if (recordingBytes + audio.length > config.maxRecordingBytes) {
          console.error(`[RECORDING] [${streamId}] recording size limit exceeded`);
          socket.close(1009, "Recording size limit exceeded");
          break;
        }

        try {
          recordingBytes += audio.length;
          if (!recorder.write(audio)) {
            socket.pause();
            recorder.onceDrain(() => {
              if (!closed && socket.readyState === WebSocket.OPEN) {
                socket.resume();
              }
            });
          }
        } catch (error) {
          console.error(`[RECORDING] [${streamId}] write failed:`, error);
          socket.close(1011, "Recording failed");
          break;
        }

        console.log(
          `[AUDIO] [${streamId}] chunk received: ${audio.length} bytes, timestamp=${media.timestamp ?? "unknown"} ms`,
        );
        for (const window of windows.push(audio)) {
          queue.enqueue(window);
        }
        break;
      }

      case "stop":
        console.log(`[STREAM] [${streamId}] stopped`);
        void finish();
        if (socket.readyState === WebSocket.OPEN) {
          socket.close(1000, "Stream stopped");
        }
        break;

      case "dtmf":
      case "mark":
      case "clear":
        console.log(`[WS] [${streamId}] ${event.event} event received`);
        break;

      default:
        console.log(`[WS] [${streamId}] unrecognized event: ${event.event}`);
    }
  });

  socket.on("close", () => {
    console.log(`[WS] [${streamId}] client disconnected`);
    void finish();
  });

  socket.on("error", (error) => {
    console.error(`[WS] [${streamId}] error:`, error);
  });

  function finish(): Promise<void> {
    if (finishPromise) {
      return finishPromise;
    }
    closed = true;

    if (windows && queue) {
      const finalWindow = windows.flush();
      if (finalWindow) {
        queue.enqueue(finalWindow);
      }
      windows.clear();
    }

    finishPromise = recorder
      .finish()
      .then(() => {
        console.log(`[RECORDING] [${streamId}] finalized: ${recorder.filePath}`);
      })
      .catch((error: unknown) => {
        console.error(`[RECORDING] [${streamId}] finalization failed:`, error);
      })
      .then(() => queue?.drain())
      .then(() => {
        console.log(`[STREAM] [${streamId}] cleanup complete`);
      });

    return finishPromise;
  }
}
