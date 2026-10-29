export interface ExotelMediaFormat {
  encoding?: unknown;
  sample_rate?: unknown;
  channels?: unknown;
  channel_count?: unknown;
  bits_per_sample?: unknown;
  sample_width?: unknown;
  [key: string]: unknown;
}

export interface ExotelStartEvent {
  event: "start";
  stream_sid?: unknown;
  start?: {
    stream_sid?: unknown;
    media_format?: ExotelMediaFormat;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface ExotelMediaEvent {
  event: "media";
  media?: {
    chunk?: unknown;
    timestamp?: unknown;
    payload?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface ExotelEvent {
  event: string;
  [key: string]: unknown;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isExotelEvent(value: unknown): value is ExotelEvent {
  return isRecord(value) && typeof value.event === "string";
}
