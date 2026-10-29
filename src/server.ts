import { loadConfig } from "./config.js";
import { createMediaServer } from "./websocket/media-server.js";
import { WebSocket } from "ws";


const { server, websocketServer } = createMediaServer(loadConfig);

server.listen(loadConfig.port, () => {
  console.log(`[SERVER] HTTP listening on port ${loadConfig.port}`);
  console.log(`[SERVER] WebSocket endpoint: ws://localhost:${loadConfig.port}/media`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`[SERVER] ${signal} received; closing connections`);
    for (const client of websocketServer.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.close(1001, "Server shutting down");
      }
    }

    server.close((error) => {
      if (error) {
        console.error("[SERVER] Shutdown failed:", error);
        process.exitCode = 1;
      }
    });
  });
}
