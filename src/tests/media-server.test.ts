import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import WebSocket from "ws";
import type { AddressInfo } from "node:net";
import type { AppConfig } from "../config.js";
import { AudioWindowBuffer } from "../services/audio-window-buffer.js";
import { createWav, createWhisperClient } from "../services/whisper-client.js";
import { TranscriptionQueue } from "../services/transcription-queue.js";
import type { Transcriber } from "../services/whisper-client.js";
import type { TtsService } from "../services/elevenlabs-tts.js";
import { VoiceActivityTurnDetector } from "../services/voice-activity-turn-detector.js";
import { createMediaServer } from "../websocket/media-server.js";

const testDirectories: string[] = [];

async function createTempDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "voice-agent-test-"));
  testDirectories.push(path);
  return path;
}

function testConfig(uploadDir: string, overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 0,
    whisperUrl: "http://127.0.0.1:8080/inference",
    whisperTimeoutMs: 1000,
    uploadDir,
    vadSilenceMs: 80,
    vadMinimumSpeechMs: 40,
    vadMaximumTurnMs: 30000,
    vadThresholdRms: 500,
    transcriptionQueueLimit: 3,
    maxWebSocketPayloadBytes: 256 * 1024,
    maxRecordingBytes: 10 * 1024 * 1024,
    ...overrides,
  };
}

async function startServer(
  config: AppConfig,
  transcribe?: Transcriber,
  ttsService: TtsService = {
    async generateSpeech() {
      return Buffer.alloc(320);
    },
  },
) {
  const application = createMediaServer(config, transcribe, ttsService);
  await new Promise<void>((resolve, reject) => {
    application.server.once("error", reject);
    application.server.listen(0, "127.0.0.1", resolve);
  });
  const address = application.server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const websocketUrl = `ws://127.0.0.1:${address.port}/media`;
  const clients = new Set<WebSocket>();

  function connect(url = websocketUrl): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const client = new WebSocket(url);
      clients.add(client);
      client.once("open", () => resolve(client));
      client.once("error", reject);
    });
  }

  async function close(): Promise<void> {
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.close();
      } else if (client.readyState !== WebSocket.CLOSED) {
        client.terminate();
      }
    }

    await new Promise<void>((resolve) => {
      application.server.close(() => resolve());
    });
  }

  return { ...application, baseUrl, websocketUrl, connect, close };
}

function sendEvent(socket: WebSocket, event: Record<string, unknown>): void {
  socket.send(JSON.stringify(event));
}

function startEvent(sampleRate = 8000) {
  return {
    event: "start",
    stream_sid: "local-test",
    start: {
      stream_sid: "local-test",
      media_format: {
        encoding: "raw",
        sample_rate: sampleRate,
      },
    },
  };
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for expected event.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("health endpoint and malformed JSON do not stop the server", async () => {
  const directory = await createTempDirectory();
  const app = await startServer(testConfig(directory));
  try {
    const response = await fetch(`${app.baseUrl}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: "ok",
      service: "voice-agent",
    });

    const socket = await app.connect();
    socket.send("{");
    sendEvent(socket, { event: "connected" });
    sendEvent(socket, startEvent());
    sendEvent(socket, { event: "media", media: { payload: "not base64!" } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal((await fetch(`${app.baseUrl}/health`)).status, 200);
    socket.close();
  } finally {
    await app.close();
  }
});

test("transcribes a completed VAD turn at the configured sample rate", async () => {
  const directory = await createTempDirectory();
  const submitted: Array<{ length: number; rate: number }> = [];
  const app = await startServer(
    testConfig(directory, { vadMinimumSpeechMs: 1 }),
    async (audio, _id, rate) => {
      submitted.push({ length: audio.length, rate });
      return "recognized caller turn";
    },
  );

  try {
    const socket = await app.connect(`${app.websocketUrl}?sample-rate=16000`);
    sendEvent(socket, startEvent(16000));
    sendEvent(socket, {
      event: "media",
      media: { payload: Buffer.alloc(32000, 0x7f).toString("base64") },
    });
    assert.equal(submitted.length, 0);
    sendEvent(socket, {
      event: "media",
      media: { payload: Buffer.alloc(2560).toString("base64") },
    });
    await waitFor(() => submitted.length === 1);
    assert.deepEqual(submitted[0], { length: 32000, rate: 16000 });
    socket.close();

    const wav = createWav(Buffer.alloc(32000), 16000);
    assert.equal(wav.toString("ascii", 0, 4), "RIFF");
    assert.equal(wav.readUInt32LE(24), 16000);
    assert.equal(wav.readUInt16LE(22), 1);
    assert.equal(wav.readUInt16LE(34), 16);
    assert.equal(wav.readUInt32LE(40), 32000);
  } finally {
    await app.close();
  }
});

test("decodes Base64 payloads when encoding metadata describes the payload representation", async () => {
  const directory = await createTempDirectory();
  const pcm = Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x34, 0x12]);
  const submitted: Array<{ bytes: Buffer; rate: number }> = [];
  const app = await startServer(
    testConfig(directory),
    async (audio, _id, rate) => {
      submitted.push({ bytes: Buffer.from(audio), rate });
      return "recognized caller turn";
    },
  );

  try {
    const socket = await app.connect();
    sendEvent(socket, {
      event: "start",
      start: {
        media_format: {
          encoding: "base64",
          sample_rate: "8000",
          bit_rate: "128000",
        },
      },
    });
    sendEvent(socket, {
      event: "media",
      media: { payload: pcm.toString("base64") },
    });
    sendEvent(socket, { event: "stop" });
    await new Promise<void>((resolve) => socket.once("close", () => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(submitted.length, 0);
    const recordings = await readdir(directory);
    assert.equal(recordings.length, 1);
    assert.deepEqual(await readFile(join(directory, recordings[0] ?? "")), pcm);
  } finally {
    await app.close();
  }
});

test("keeps brief pauses inside one caller turn and transcribes after silence", async () => {
  const directory = await createTempDirectory();
  const submitted: Array<{ bytes: Buffer; rate: number }> = [];
  const app = await startServer(
    testConfig(directory, { vadSilenceMs: 700 }),
    async (audio, _id, rate) => {
      submitted.push({ bytes: Buffer.from(audio), rate });
      return "recognized caller turn";
    },
  );

  try {
    const socket = await app.connect();
    sendEvent(socket, { event: "connected" });
    sendEvent(socket, startEvent());

    const firstHalf = Buffer.alloc(24000, 0x11);
    const briefPause = Buffer.alloc(3200);
    const secondHalf = Buffer.alloc(24000, 0x22);
    sendEvent(socket, {
      event: "media",
      media: { payload: firstHalf.toString("base64") },
    });
    assert.equal(submitted.length, 0);
    sendEvent(socket, {
      event: "media",
      media: { payload: briefPause.toString("base64") },
    });
    sendEvent(socket, {
      event: "media",
      media: { payload: secondHalf.toString("base64") },
    });
    assert.equal(submitted.length, 0);
    sendEvent(socket, {
      event: "media",
      media: { payload: Buffer.alloc(11200).toString("base64") },
    });
    await waitFor(() => submitted.length === 1);
    sendEvent(socket, { event: "stop" });
    await new Promise<void>((resolve) => socket.once("close", () => resolve()));

    assert.deepEqual(submitted[0]?.bytes, Buffer.concat([firstHalf, briefPause, secondHalf]));
    assert.equal(submitted[0]?.rate, 8000);

    const recordings = await readdir(directory);
    assert.equal(recordings.length, 1);
    assert.match(recordings[0] ?? "", /^[0-9a-f-]+\.pcm$/i);
    assert.deepEqual(
      await readFile(join(directory, recordings[0] ?? "")),
      Buffer.concat([firstHalf, briefPause, secondHalf, Buffer.alloc(11200)]),
    );
  } finally {
    await app.close();
  }
});

test("keeps the WebSocket open across completed caller turns until Exotel stops the stream", async () => {
  const directory = await createTempDirectory();
  const submitted: Buffer[] = [];
  const app = await startServer(
    testConfig(directory),
    async (audio) => {
      submitted.push(Buffer.from(audio));
      return "recognized caller turn";
    },
    {
      async generateSpeech() {
        return Buffer.alloc(16000);
      },
    },
  );

  try {
    const socket = await app.connect();
    const playbackStarted = new Promise<void>((resolve) => {
      socket.on("message", (raw) => {
        const event = JSON.parse(raw.toString()) as { event?: string };
        if (event.event === "media") {
          resolve();
        }
      });
    });
    sendEvent(socket, startEvent());

    const firstSpeech = Buffer.alloc(8000, 0x21);
    sendEvent(socket, {
      event: "media",
      media: { payload: firstSpeech.toString("base64") },
    });
    sendEvent(socket, {
      event: "media",
      media: { payload: Buffer.alloc(1280).toString("base64") },
    });
    await waitFor(() => submitted.length === 1);
    assert.equal(submitted[0]?.length, firstSpeech.length);
    assert.equal(socket.readyState, WebSocket.OPEN);
    await playbackStarted;

    const laterAudio = Buffer.alloc(3200, 0x42);
    sendEvent(socket, {
      event: "media",
      media: { payload: laterAudio.toString("base64") },
    });
    sendEvent(socket, {
      event: "media",
      media: { payload: Buffer.alloc(1280).toString("base64") },
    });
    await waitFor(() => submitted.length === 2);
    const close = new Promise<{ code: number; reason: string }>((resolve) => {
      socket.once("close", (code, reason) => {
        resolve({ code, reason: reason.toString() });
      });
    });
    sendEvent(socket, {
      event: "stop",
      stop: { reason: "stopped" },
    });
    assert.deepEqual(await close, { code: 1000, reason: "Stream stopped" });
    await waitFor(() => submitted.length === 2);

    assert.deepEqual(submitted[1], laterAudio);
    const expectedRecording = Buffer.concat([
      firstSpeech,
      Buffer.alloc(1280),
      laterAudio,
      Buffer.alloc(1280),
    ]);
    await waitFor(async () => {
      const files = await readdir(directory);
      return (
        files.length === 1 &&
        (await readFile(join(directory, files[0] ?? ""))).equals(expectedRecording)
      );
    });
    const recordings = await readdir(directory);
    assert.equal(recordings.length, 1);
    assert.deepEqual(
      await readFile(join(directory, recordings[0] ?? "")),
      expectedRecording,
    );
  } finally {
    await app.close();
  }
});

test("rejects incompatible format metadata and closes the stream", async () => {
  const directory = await createTempDirectory();
  const app = await startServer(testConfig(directory));
  try {
    const socket = await app.connect();
    const closed = new Promise<number>((resolve) => {
      socket.once("close", (code) => resolve(code));
    });
    sendEvent(socket, {
      event: "start",
      start: {
        media_format: {
          encoding: "opus",
          sample_rate: 8000,
        },
      },
    });
    assert.equal(await closed, 1003);
  } finally {
    await app.close();
  }
});

test("audio window buffer preserves bytes across chunk boundaries", () => {
  const windows = new AudioWindowBuffer(6);
  assert.deepEqual(windows.push(Buffer.from([1, 2, 3, 4])), []);
  assert.deepEqual(windows.push(Buffer.from([5, 6, 7, 8, 9, 10, 11, 12])), [
    Buffer.from([1, 2, 3, 4, 5, 6]),
    Buffer.from([7, 8, 9, 10, 11, 12]),
  ]);
  assert.equal(windows.bufferedBytes, 0);
  assert.equal(windows.flush(), undefined);
});

test("VAD frames PCM across payload boundaries and keeps short pauses in a turn", () => {
  const completed: Buffer[] = [];
  let speechStarts = 0;
  const detector = new VoiceActivityTurnDetector({
    sampleRate: 8000,
    silenceMs: 60,
    minimumSpeechMs: 40,
    maximumTurnMs: 30000,
    thresholdRms: 500,
    onSpeechStart: () => {
      speechStarts += 1;
    },
    onTurnComplete: (audio) => completed.push(audio),
  });
  const speech = Buffer.alloc(640, 0x7f);
  const briefPause = Buffer.alloc(320);
  const trailingSilence = Buffer.alloc(960);

  detector.push(speech.subarray(0, 160));
  assert.equal(speechStarts, 0);
  detector.push(speech.subarray(160));
  assert.equal(speechStarts, 1);
  detector.push(briefPause);
  detector.push(speech);
  detector.push(trailingSilence);

  assert.equal(completed.length, 1);
  assert.deepEqual(completed[0], Buffer.concat([speech, briefPause, speech]));
});

test("VAD finalizes at the configured maximum turn duration", () => {
  const completed: Buffer[] = [];
  const detector = new VoiceActivityTurnDetector({
    sampleRate: 8000,
    silenceMs: 700,
    minimumSpeechMs: 40,
    maximumTurnMs: 60,
    thresholdRms: 500,
    onTurnComplete: (audio) => completed.push(audio),
  });
  const speech = Buffer.alloc(960, 0x7f);

  detector.push(speech);

  assert.deepEqual(completed, [speech]);
});

test("transcription queue is bounded and safely absorbs failures", async () => {
  let release!: () => void;
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queue = new TranscriptionQueue(
    "test-stream",
    async (): Promise<string> => {
      started();
      await blocked;
      throw new Error("simulated Whisper failure");
    },
    1,
    8000,
  );
  let transcriptionError: unknown;
  queue.onError((error) => {
    transcriptionError = error;
  });

  assert.equal(queue.enqueue(Buffer.alloc(10)), true);
  await startedPromise;
  assert.equal(queue.enqueue(Buffer.alloc(10)), false);
  release();
  await assert.doesNotReject(queue.drain());
  assert.match(String(transcriptionError), /simulated Whisper failure/);
});

test("Whisper client rejects unsuccessful and malformed responses", async () => {
  const clientConfig = {
    whisperUrl: "http://localhost:8080/inference",
    whisperTimeoutMs: 500,
  };
  const failedClient = createWhisperClient(clientConfig, async () =>
    new Response("unavailable", { status: 503 }),
  );
  await assert.rejects(
    failedClient(Buffer.alloc(1600), "test-stream", 8000),
    /Whisper HTTP 503/,
  );

  const malformedClient = createWhisperClient(clientConfig, async () =>
    new Response("not json", { status: 200 }),
  );
  await assert.rejects(
    malformedClient(Buffer.alloc(1600), "test-stream", 8000),
    /malformed JSON/,
  );
});

test("closes and finalizes recording after an unexpected disconnect", async () => {
  const directory = await createTempDirectory();
  const app = await startServer(testConfig(directory), async () => "");
  try {
    const socket = await app.connect();
    sendEvent(socket, startEvent());
    const audio = Buffer.alloc(8000, 0x44);
    sendEvent(socket, {
      event: "media",
      media: { payload: audio.toString("base64") },
    });
    const disconnected = new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
    });
    socket.terminate();
    await disconnected;
    await waitFor(async () => (await readdir(directory)).length === 1);
    const recordings = await readdir(directory);
    assert.deepEqual(await readFile(join(directory, recordings[0] ?? "")), audio);
  } finally {
    await app.close();
  }
});

after(async () => {
  await Promise.all(
    testDirectories.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});
