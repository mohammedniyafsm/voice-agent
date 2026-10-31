export interface ElevenLabsConfig {
  apiKey?: string;
  voiceId?: string;
  modelId?: string;
  timeoutMs?: number;
}

export interface TtsService {
  /**
   * Generates PCM 16-bit mono audio at requested sample rate (default 8000 Hz for Exotel).
   */
  generateSpeech(text: string, sampleRate?: number): Promise<Buffer>;
}

export function createElevenLabsService(
  config: ElevenLabsConfig = {},
  fetcher: typeof fetch = fetch,
): TtsService {
  const apiKey = config.apiKey ?? process.env.ELEVENLABS_API_KEY;
  const voiceId = config.voiceId ?? process.env.ELEVENLABS_VOICE_ID ?? "JBFqnCBsd6RMkjVDRZzb"; // George (Default free-tier voice)
  const modelId = config.modelId ?? process.env.ELEVENLABS_MODEL_ID ?? "eleven_flash_v2_5";
  const timeoutMs = config.timeoutMs ?? 15000;

  return {
    async generateSpeech(text: string, sampleRate = 8000): Promise<Buffer> {
      const cleanText = text.trim();
      if (!cleanText) {
        throw new Error("Text for TTS cannot be empty.");
      }

      if (!apiKey) {
        throw new Error("ELEVENLABS_API_KEY is not configured.");
      }

      // ElevenLabs supports output_format query parameter
      // Format: pcm_8000, pcm_16000, pcm_24000 (signed 16-bit little-endian mono PCM)
      const format = sampleRate === 16000 ? "pcm_16000" : sampleRate === 24000 ? "pcm_24000" : "pcm_8000";
      const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(
        voiceId,
      )}?output_format=${format}`;

      const response = await fetcher(url, {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
          Accept: "audio/pcm",
        },
        body: JSON.stringify({
          text: cleanText,
          model_id: modelId,
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
          },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        let errorDetails = "";
        try {
          errorDetails = (await response.text()).slice(0, 500);
        } catch {
          errorDetails = response.statusText;
        }
        throw new Error(`ElevenLabs TTS HTTP ${response.status}: ${errorDetails}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      const pcmBuffer = Buffer.from(arrayBuffer);

      if (pcmBuffer.length === 0) {
        throw new Error("ElevenLabs returned empty audio payload.");
      }

      return pcmBuffer;
    },
  };
}

