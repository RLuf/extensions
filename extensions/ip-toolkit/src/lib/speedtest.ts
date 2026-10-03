/** Cloudflare's public speed test endpoints (the same ones used by speed.cloudflare.com). */
const DOWNLOAD_URL = "https://speed.cloudflare.com/__down?bytes=";
const UPLOAD_URL = "https://speed.cloudflare.com/__up";

export const DOWNLOAD_BYTES = 25_000_000;
export const UPLOAD_BYTES = 5 * 1024 * 1024;
const LATENCY_SAMPLES = 5;
const STEP_TIMEOUT_MS = 60_000;

export interface SpeedResult {
  latencyMs?: number;
  downloadMbps?: number;
  uploadMbps?: number;
}

/** Megabits per second, decimal (1 Mbps = 1,000,000 bits/s), like every ISP and speed test. */
export function toMbps(bytes: number, milliseconds: number): number {
  return (bytes * 8) / (milliseconds / 1000) / 1_000_000;
}

function stepSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(STEP_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Median round trip of tiny requests, after one warm-up request that opens the connection. */
export async function measureLatency(signal?: AbortSignal): Promise<number> {
  const samples: number[] = [];
  for (let index = 0; index <= LATENCY_SAMPLES; index++) {
    const started = performance.now();
    const response = await fetch(`${DOWNLOAD_URL}0`, { signal: stepSignal(signal) });
    await response.arrayBuffer();
    if (index > 0) {
      samples.push(performance.now() - started);
    }
  }
  samples.sort((a, b) => a - b);
  return Math.round(samples[Math.floor(samples.length / 2)]);
}

export async function measureDownload(signal?: AbortSignal): Promise<number> {
  const started = performance.now();
  const response = await fetch(`${DOWNLOAD_URL}${DOWNLOAD_BYTES}`, { signal: stepSignal(signal) });
  if (!response.ok) {
    throw new Error(`Download test failed (HTTP ${response.status})`);
  }
  const data = await response.arrayBuffer();
  return toMbps(data.byteLength, performance.now() - started);
}

export async function measureUpload(signal?: AbortSignal): Promise<number> {
  const payload = new Uint8Array(UPLOAD_BYTES);
  const started = performance.now();
  const response = await fetch(UPLOAD_URL, {
    method: "POST",
    body: payload,
    headers: { "Content-Type": "application/octet-stream" },
    signal: stepSignal(signal),
  });
  await response.arrayBuffer();
  if (!response.ok) {
    throw new Error(`Upload test failed (HTTP ${response.status})`);
  }
  return toMbps(payload.byteLength, performance.now() - started);
}
