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
    audioWindowSeconds: 3,
    transcriptionQueueLimit: 3,
    maxWebSocketPayloadBytes: 256 * 1024,
    maxRecordingBytes: 10 * 1024 * 1024,
    ...overrides,
  };
}

async function startServer(
  config: AppConfig,
  transcribe?: (audio: Buffer, streamId: string, sampleRate: number) => Promise<void>,
) {
  const application = createMediaServer(config, transcribe);
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

test("uses the configured sample rate for windows and Whisper WAV data", async () => {
  const directory = await createTempDirectory();
  const submitted: Array<{ length: number; rate: number }> = [];
  const app = await startServer(
    testConfig(directory, { audioWindowSeconds: 1 }),
    async (audio, _id, rate) => {
      submitted.push({ length: audio.length, rate });
    },
  );

  try {
    const socket = await app.connect(`${app.websocketUrl}?sample-rate=16000`);
    sendEvent(socket, startEvent(16000));
    sendEvent(socket, {
      event: "media",
      media: { payload: Buffer.alloc(32000, 0x7f).toString("base64") },
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

test("records PCM and submits full and final partial windows in order", async () => {
  const directory = await createTempDirectory();
  const submitted: Array<{ bytes: Buffer; rate: number }> = [];
  let resolveFirst!: () => void;
  const firstSubmission = new Promise<void>((resolve) => {
    resolveFirst = resolve;
  });
  const app = await startServer(testConfig(directory), async (audio, _id, rate) => {
    submitted.push({ bytes: Buffer.from(audio), rate });
    if (submitted.length === 1) {
      resolveFirst();
    }
  });

  try {
    const socket = await app.connect();
    sendEvent(socket, { event: "connected" });
    sendEvent(socket, startEvent());

    const firstHalf = Buffer.alloc(24000, 0x11);
    const secondHalf = Buffer.alloc(24000, 0x22);
    const tail = Buffer.alloc(4000, 0x33);
    sendEvent(socket, {
      event: "media",
      media: { timestamp: "0", payload: firstHalf.toString("base64") },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(submitted.length, 0);

    sendEvent(socket, {
      event: "media",
      media: { timestamp: "1500", payload: secondHalf.toString("base64") },
    });
    await firstSubmission;
    sendEvent(socket, {
      event: "media",
      media: { timestamp: "3000", payload: tail.toString("base64") },
    });
    sendEvent(socket, { event: "stop" });
    await new Promise<void>((resolve) => socket.once("close", () => resolve()));
    await waitFor(() => submitted.length === 2);

    assert.equal(submitted[0]?.bytes.length, 48000);
    assert.equal(submitted[1]?.bytes.length, 4000);
    assert.deepEqual(
      submitted[0]?.bytes,
      Buffer.concat([firstHalf, secondHalf]),
    );
    assert.equal(submitted[0]?.rate, 8000);

    const recordings = await readdir(directory);
    assert.equal(recordings.length, 1);
    assert.match(recordings[0] ?? "", /^[0-9a-f-]+\.pcm$/i);
    assert.deepEqual(
      await readFile(join(directory, recordings[0] ?? "")),
      Buffer.concat([firstHalf, secondHalf, tail]),
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
    async () => {
      started();
      await blocked;
      throw new Error("simulated Whisper failure");
    },
    1,
    8000,
  );

  assert.equal(queue.enqueue(Buffer.alloc(10)), true);
  await startedPromise;
  assert.equal(queue.enqueue(Buffer.alloc(10)), false);
  release();
  await assert.doesNotReject(queue.drain());
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
  const app = await startServer(testConfig(directory), async () => {});
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
