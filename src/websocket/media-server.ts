import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import express from "express";
import { WebSocket, WebSocketServer } from "ws";
import type { IncomingMessage } from "node:http";
import type { AppConfig } from "../config.js";
import { AudioRecorder } from "../services/audio-recorder.js";
import { createWhisperClient } from "../services/whisper-client.js";
import type { Transcriber } from "../services/whisper-client.js";
import { TranscriptionQueue } from "../services/transcription-queue.js";
import { createHotelAgent } from "../services/hotel-agent.js";
import { VoiceActivityTurnDetector } from "../services/voice-activity-turn-detector.js";
import { createElevenLabsService, type TtsService } from "../services/elevenlabs-tts.js";
import { ExotelAudioPlayer } from "../services/exotel-audio-player.js";
import type { ExotelMediaFormat } from "../types/exotel.js";
import { isExotelEvent, isRecord } from "../types/exotel.js";

const SAMPLE_RATES = new Set([8000, 16000, 24000]);
const PCM_BYTES_PER_SAMPLE = 2;
const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?$/;

interface AudioFormat {
  sampleRate: number;
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
): AudioFormat {
  const encoding = mediaFormat?.encoding;
  if (
    encoding !== undefined &&
    (typeof encoding !== "string" ||
      !["raw", "slin", "audio/pcm", "base64"].includes(encoding.toLowerCase()))
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

  return { sampleRate };
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

function safeDiagnosticText(value: string): string {
  return value
    .replace(/\+?\d[\d\s().-]{5,}\d/g, "[redacted-number]")
    .replace(/\b[A-Za-z0-9_-]{16,}\b/g, "[redacted-id]")
    .slice(0, 120);
}

export function createMediaServer(
  config: AppConfig,
  transcribe: Transcriber = createWhisperClient(config),
  ttsService: TtsService = createElevenLabsService(),
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
    handleConnection(socket, request, config, transcribe, ttsService);
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
  ttsService: TtsService,
): void {
  const streamId = randomUUID();
  const connectedAt = Date.now();
  let applicationCloseReason: string | undefined;

  function closeSocket(code: number, reason: string): void {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }

    applicationCloseReason = reason;
    console.log(
      `[WS] [${streamId}] application closing socket: code=${code}, reason=${reason}`,
    );
    socket.close(code, reason);
  }

  let rateFromUrl: number;

  try {
    rateFromUrl = requestedSampleRate(request);
  } catch (error) {
    console.error(`[WS] [${streamId}] invalid stream URL:`, error);
    closeSocket(1008, "Invalid sample-rate configuration");
    return;
  }

  let recorder: AudioRecorder;
  try {
    recorder = new AudioRecorder(config.uploadDir, config.maxRecordingBytes);
  } catch (error) {
    console.error(`[RECORDING] [${streamId}] could not create recording:`, error);
    closeSocket(1011, "Recording could not be created");
    return;
  }

  let format: AudioFormat | undefined;
  let queue: TranscriptionQueue | undefined;
  let turnDetector: VoiceActivityTurnDetector | undefined;
  let audioPlayer: ExotelAudioPlayer | undefined;
  let exotelStreamSid: string | undefined;
  let recordingBytes = 0;
  let audioChunks = 0;
  let audioBytes = 0;
  let receivedStopEvent = false;
  let stopReason: string | undefined;
  let closed = false;
  let loggedMediaShape = false;
  let finishPromise: Promise<void> | undefined;
  let conversationState:
    | "LISTENING"
    | "THINKING"
    | "SPEAKING"
    | "INTERRUPTED" = "LISTENING";

  console.log(`[WS] [${streamId}] client connected`);
  console.log(`[RECORDING] [${streamId}] file created: ${recorder.filePath}`);

  recorder.onError((error) => {
    console.error(`[RECORDING] [${streamId}] write failed:`, error);
    if (socket.readyState === WebSocket.OPEN) {
      closeSocket(1011, "Recording failed");
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

    if (event.event === "start") {
      const start = isRecord(event.start) ? event.start : {};
      const mediaFormat = isRecord(start.media_format) ? start.media_format : {};
      console.log(
        `[WS] [${streamId}] start message shape: ${JSON.stringify({
          event: event.event,
          keys: Object.keys(event),
          startKeys: Object.keys(start),
          mediaFormat: {
            keys: Object.keys(mediaFormat),
            encoding: mediaFormat.encoding,
            sample_rate: mediaFormat.sample_rate,
            bit_rate: mediaFormat.bit_rate,
          },
        })}`,
      );
    } else if (event.event === "media" && !loggedMediaShape) {
      loggedMediaShape = true;
      const media = isRecord(event.media) ? event.media : {};
      const payload = media.payload;
      console.log(
        `[WS] [${streamId}] first media message shape: ${JSON.stringify({
          event: event.event,
          keys: Object.keys(event),
          mediaKeys: Object.keys(media),
          payloadType: typeof payload,
          payloadLength: typeof payload === "string" ? payload.length : undefined,
        })}`,
      );
    }

    switch (event.event) {
      case "connected":
        console.log(`[WS] [${streamId}] Exotel stream connected`);
        break;

      case "start": {
        if (format) {
          console.error(`[STREAM] [${streamId}] duplicate start event`);
          closeSocket(1008, "Duplicate start event");
          break;
        }

        const start = isRecord(event.start) ? event.start : {};
        exotelStreamSid =
          typeof event.stream_sid === "string"
            ? event.stream_sid
            : typeof start.stream_sid === "string"
            ? start.stream_sid
            : streamId;

        audioPlayer = new ExotelAudioPlayer(socket, exotelStreamSid);
        const mediaFormat: ExotelMediaFormat | undefined = isRecord(start.media_format)
          ? start.media_format
          : undefined;

        try {
          format = validateAudioFormat(
            mediaFormat,
            rateFromUrl,
          );
          queue = new TranscriptionQueue(
            streamId,
            transcribe,
            config.transcriptionQueueLimit,
            format.sampleRate,
          );
          const hotelAgent = createHotelAgent();
          turnDetector = new VoiceActivityTurnDetector({
            sampleRate: format.sampleRate,
            silenceMs: config.vadSilenceMs,
            minimumSpeechMs: config.vadMinimumSpeechMs,
            maximumTurnMs: config.vadMaximumTurnMs,
            thresholdRms: config.vadThresholdRms,
            onSpeechStart: () => {
              if (conversationState === "SPEAKING") {
                conversationState = "INTERRUPTED";
                audioPlayer?.interrupt();
              }
            },
            onTurnComplete: (audio) => {
              if (conversationState === "SPEAKING") {
                conversationState = "INTERRUPTED";
                audioPlayer?.interrupt();
              }
              if (
                conversationState !== "LISTENING" &&
                conversationState !== "INTERRUPTED"
              ) {
                return;
              }
              conversationState = "THINKING";
              if (!queue?.enqueue(audio)) {
                conversationState = "LISTENING";
              }
            },
          });

          queue.onTranscript(async (text) => {
            if (conversationState !== "THINKING") {
              return;
            }
            if (!text.trim()) {
              conversationState = "LISTENING";
              return;
            }
            console.log(`[AGENT] [${streamId}] User said: "${text}"`);
            const reply = await hotelAgent.chat(text);
            console.log(`[AGENT] [${streamId}] Gemini reply: "${reply}"`);

            if (!reply || !audioPlayer || socket.readyState !== WebSocket.OPEN) {
              conversationState = "LISTENING";
              return;
            }

            try {
              console.log(`[TTS] [${streamId}] Generating speech via ElevenLabs...`);
              const pcmAudio = await ttsService.generateSpeech(
                reply,
                format?.sampleRate ?? 8000,
              );
              if (conversationState !== "THINKING") {
                return;
              }
              conversationState = "SPEAKING";
              await audioPlayer.playPcm(pcmAudio);
            } catch (ttsErr) {
              console.error(`[TTS] [${streamId}] Generation/playback error:`, ttsErr);
            } finally {
              if (
                conversationState === "SPEAKING" ||
                conversationState === "THINKING"
              ) {
                conversationState = "LISTENING";
              }
            }
          });
          queue.onError(() => {
            if (conversationState === "THINKING") {
              conversationState = "LISTENING";
            }
          });
          console.log(
            `[STREAM] [${streamId}] started; payload_encoding=${mediaFormat?.encoding ?? "not specified"}, audio=raw/slin PCM, sample_rate=${format.sampleRate}, channels=1, bits_per_sample=16`,
          );
        } catch (error) {
          console.error(`[STREAM] [${streamId}] unsupported audio format:`, error);
          closeSocket(1003, "Unsupported audio format");
        }
        break;
      }

      case "media": {
        if (!recorder || !queue || !turnDetector || !format) {
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
          closeSocket(1009, "Recording size limit exceeded");
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
          closeSocket(1011, "Recording failed");
          break;
        }

        audioChunks += 1;
        audioBytes += audio.length;
        if (
          conversationState === "LISTENING" ||
          conversationState === "SPEAKING" ||
          conversationState === "INTERRUPTED"
        ) {
          turnDetector?.push(audio);
        }
        break;
      }

      case "stop": {
        const stop = isRecord(event.stop) ? event.stop : {};
        receivedStopEvent = true;
        stopReason =
          typeof stop.reason === "string"
            ? safeDiagnosticText(stop.reason)
            : undefined;
        console.log(
          `[STREAM] [${streamId}] stop event received: ${JSON.stringify({
            keys: Object.keys(event),
            stopKeys: Object.keys(stop),
            reason: stopReason ?? "not provided",
          })}`,
        );
        void finish();
        closeSocket(1000, "Stream stopped");
        break;
      }

      case "dtmf":
      case "mark":
      case "clear":
        console.log(`[WS] [${streamId}] ${event.event} event received`);
        break;

      default:
        console.log(`[WS] [${streamId}] unrecognized event: ${event.event}`);
    }
  });

  socket.on("close", (code, rawReason) => {
    const closeReason = safeDiagnosticText(rawReason.toString());
    console.log(
      `[WS] [${streamId}] client disconnected: ${JSON.stringify({
        code,
        reason: closeReason || "not provided",
        applicationInitiated: applicationCloseReason !== undefined,
        applicationCloseReason: applicationCloseReason ?? "none",
        stopReceived: receivedStopEvent,
        stopReason: stopReason ?? "not provided",
        durationMs: Date.now() - connectedAt,
        audioChunks,
        audioBytes,
      })}`,
    );
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
    console.log(
      `[STREAM] [${streamId}] finalizing: stopReceived=${receivedStopEvent}, audioChunks=${audioChunks}, audioBytes=${audioBytes}`,
    );

    if (turnDetector && queue) {
      turnDetector.flush();
      turnDetector.clear();
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
