import WebSocket from "ws";

const port = process.env.PORT ?? "3000";
const sampleRate = Number(process.argv[2] ?? "8000");
const durationSeconds = Number(process.argv[3] ?? "4");
const supportedSampleRates = new Set([8000, 16000, 24000]);

if (!supportedSampleRates.has(sampleRate)) {
  throw new Error("Sample rate must be 8000, 16000, or 24000.");
}
if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
  throw new Error("Duration must be a positive number of seconds.");
}

const frameDurationMs = 100;
const frameBytes = (sampleRate * frameDurationMs * 2) / 1000;
const socket = new WebSocket(
  `ws://localhost:${port}/media?sample-rate=${sampleRate}`,
);

console.log("[SIMULATOR] This is a local protocol simulation, not an Exotel call.");

socket.on("open", async () => {
  socket.send(JSON.stringify({ event: "connected" }));
  socket.send(
    JSON.stringify({
      event: "start",
      stream_sid: "local-simulation",
      start: {
        stream_sid: "local-simulation",
        media_format: {
          encoding: "raw",
          sample_rate: sampleRate,
          bit_rate: sampleRate * 16,
        },
      },
    }),
  );

  const frameCount = Math.ceil((durationSeconds * 1000) / frameDurationMs);
  for (let frame = 0; frame < frameCount; frame += 1) {
    socket.send(
      JSON.stringify({
        event: "media",
        stream_sid: "local-simulation",
        media: {
          chunk: frame + 1,
          timestamp: String(frame * frameDurationMs),
          payload: Buffer.alloc(frameBytes).toString("base64"),
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, frameDurationMs));
  }

  socket.send(
    JSON.stringify({
      event: "stop",
      stream_sid: "local-simulation",
    }),
  );
  socket.close();
});

socket.on("error", (error) => {
  console.error("[SIMULATOR] WebSocket error:", error);
  process.exitCode = 1;
});

socket.on("close", () => {
  console.log("[SIMULATOR] Local stream closed.");
});
