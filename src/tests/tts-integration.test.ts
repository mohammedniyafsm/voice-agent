import test from "node:test";
import assert from "node:assert/strict";
import { createElevenLabsService } from "../services/elevenlabs-tts.js";
import { ExotelAudioPlayer } from "../services/exotel-audio-player.js";
import { WebSocket } from "ws";

test("ElevenLabs TTS service validates input and requests PCM audio", async () => {
  let capturedUrl = "";
  let capturedHeaders: Record<string, string> = {};
  let capturedBody: any = null;

  const fakeFetcher = async (url: any, opts: any) => {
    capturedUrl = url.toString();
    capturedHeaders = opts.headers;
    capturedBody = JSON.parse(opts.body);
    // Return mock 8000Hz 16-bit PCM bytes (e.g. 640 bytes = 20ms of audio)
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => new Uint8Array(640).buffer,
    } as any;
  };

  const tts = createElevenLabsService(
    {
      apiKey: "test-api-key",
      voiceId: "test-voice-id",
      modelId: "eleven_flash_v2_5",
    },
    fakeFetcher,
  );

  const audio = await tts.generateSpeech("Welcome to our hotel", 8000);

  assert.equal(audio.length, 640);
  assert.ok(capturedUrl.includes("output_format=pcm_8000"));
  assert.ok(capturedUrl.includes("test-voice-id"));
  assert.equal(capturedHeaders["xi-api-key"], "test-api-key");
  assert.equal(capturedBody.text, "Welcome to our hotel");
  assert.equal(capturedBody.model_id, "eleven_flash_v2_5");
});

test("ElevenLabs TTS service rejects empty text", async () => {
  const tts = createElevenLabsService({ apiKey: "test-key" });
  await assert.rejects(async () => {
    await tts.generateSpeech("   ");
  }, /cannot be empty/);
});

test("ElevenLabs TTS service handles API error responses gracefully", async () => {
  const fakeFetcher = async () => {
    return {
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ detail: { message: "Invalid API key" } }),
    } as any;
  };

  const tts = createElevenLabsService({ apiKey: "invalid-key" }, fakeFetcher);
  await assert.rejects(async () => {
    await tts.generateSpeech("Hello", 8000);
  }, /ElevenLabs TTS HTTP 401/);
});

test("ExotelAudioPlayer formats chunks as 320-byte aligned Base64 media messages", async () => {
  const sentMessages: string[] = [];

  const fakeSocket = {
    readyState: WebSocket.OPEN,
    send(data: string) {
      sentMessages.push(data);
    },
  } as unknown as WebSocket;

  const player = new ExotelAudioPlayer(fakeSocket, "stream-1234", {
    chunkSizeBytes: 640,
    chunkIntervalMs: 1,
  });

  // Provide 1280 bytes of test PCM (2 chunks of 640 bytes)
  const testPcm = Buffer.alloc(1280, 0x12);
  await player.playPcm(testPcm);

  assert.equal(sentMessages.length, 2);

  for (const raw of sentMessages) {
    const msg = JSON.parse(raw);
    assert.equal(msg.event, "media");
    assert.equal(msg.stream_sid, "stream-1234");
    assert.ok(typeof msg.media?.payload === "string");

    // Decode and verify 320-byte alignment
    const decoded = Buffer.from(msg.media.payload, "base64");
    assert.equal(decoded.length % 320, 0);
  }
});

test("ExotelAudioPlayer sends clear frame on interruption when playing", async () => {
  const sentMessages: string[] = [];

  const fakeSocket = {
    readyState: WebSocket.OPEN,
    send(data: string) {
      sentMessages.push(data);
    },
  } as unknown as WebSocket;

  const player = new ExotelAudioPlayer(fakeSocket, "stream-5678", {
    chunkSizeBytes: 320,
    chunkIntervalMs: 50,
  });

  // Start playing in background
  const playPromise = player.playPcm(Buffer.alloc(3200));

  // Caller interrupts while playing
  player.interrupt();
  await playPromise;

  const clearMessages = sentMessages
    .map((s) => JSON.parse(s))
    .filter((m) => m.event === "clear");

  assert.equal(clearMessages.length, 1);
  assert.equal(clearMessages[0].stream_sid, "stream-5678");
});

