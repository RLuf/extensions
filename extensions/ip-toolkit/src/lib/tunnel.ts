import { LocalStorage } from "@raycast/api";
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { run } from "./windows-net";

export type TunnelTool = "cloudflared" | "ngrok";

export interface TunnelToolInfo {
  id: TunnelTool;
  title: string;
  executable: string;
  downloadPage: string;
  directDownload: string;
  wingetId: string;
  setupPage?: string;
}

export const TUNNEL_TOOLS: Record<TunnelTool, TunnelToolInfo> = {
  cloudflared: {
    id: "cloudflared",
    title: "Cloudflare Quick Tunnel",
    executable: "cloudflared.exe",
    downloadPage: "https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/",
    directDownload: "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.msi",
    wingetId: "Cloudflare.cloudflared",
  },
  ngrok: {
    id: "ngrok",
    title: "ngrok Tunnel",
    executable: "ngrok.exe",
    downloadPage: "https://ngrok.com/download",
    directDownload: "https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-windows-amd64.zip",
    wingetId: "Ngrok.Ngrok",
    setupPage: "https://dashboard.ngrok.com/get-started/your-authtoken",
  },
};

export interface StoredTunnel {
  tool: TunnelTool;
  pid: number;
  port: number;
  url: string;
  startedAt: string;
  logFile: string;
}

const STORAGE_KEY = "tunnels";
const START_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;
const NGROK_API = "http://127.0.0.1:4040/api/tunnels";

/** Places winget, the MSI installer and Chocolatey/Scoop usually put the binaries. */
function candidatePaths(executable: string): string[] {
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  return [
    join(localAppData, "Microsoft", "WinGet", "Links", executable),
    join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "cloudflared", executable),
    join(process.env.ProgramFiles ?? "C:\\Program Files", "cloudflared", executable),
    join(process.env.ProgramData ?? "C:\\ProgramData", "chocolatey", "bin", executable),
    join(homedir(), "scoop", "shims", executable),
  ];
}

export async function findExecutable(tool: TunnelTool): Promise<string | undefined> {
  const { executable } = TUNNEL_TOOLS[tool];
  try {
    const firstMatch = (await run("where.exe", [executable], 5000)).split(/\r?\n/)[0]?.trim();
    if (firstMatch) {
      return firstMatch;
    }
  } catch {
    // Not on PATH; try the usual install folders below.
  }
  return candidatePaths(executable).find((path) => existsSync(path));
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function readStoredTunnels(): Promise<StoredTunnel[]> {
  const raw = await LocalStorage.getItem<string>(STORAGE_KEY);
  if (!raw) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as StoredTunnel[]) : [];
  } catch {
    return [];
  }
}

async function writeStoredTunnels(tunnels: StoredTunnel[]) {
  await LocalStorage.setItem(STORAGE_KEY, JSON.stringify(tunnels));
}

/** Tunnels started by this extension that are still running; dead entries are pruned. */
export async function getActiveTunnels(): Promise<StoredTunnel[]> {
  const stored = await readStoredTunnels();
  const alive = stored.filter((tunnel) => isProcessAlive(tunnel.pid));
  if (alive.length !== stored.length) {
    await writeStoredTunnels(alive);
  }
  return alive;
}

export interface ExternalNgrokTunnel {
  url: string;
  address: string;
}

/** Tunnels of any ngrok agent already running on this machine (its local API on port 4040). */
export async function getNgrokAgentTunnels(): Promise<ExternalNgrokTunnel[]> {
  try {
    const response = await fetch(NGROK_API, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) {
      return [];
    }
    const body = (await response.json()) as { tunnels?: { public_url?: string; config?: { addr?: string } }[] };
    return (body.tunnels ?? [])
      .filter((tunnel) => tunnel.public_url)
      .map((tunnel) => ({ url: tunnel.public_url as string, address: tunnel.config?.addr ?? "" }));
  } catch {
    return [];
  }
}

const CLOUDFLARE_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const NGROK_URL = /url=(https:\/\/\S+)/;
const NGROK_ERROR = /(ERR_NGROK_\d+)/;

function readLog(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

export function extractTunnelUrl(tool: TunnelTool, log: string): string | undefined {
  if (tool === "cloudflared") {
    return CLOUDFLARE_URL.exec(log)?.[0];
  }
  return NGROK_URL.exec(log)?.[1];
}

function explainFailure(tool: TunnelTool, log: string): string {
  const ngrokError = NGROK_ERROR.exec(log)?.[1];
  if (ngrokError === "ERR_NGROK_4018") {
    return "ngrok needs an authtoken. Add it with: ngrok config add-authtoken <token>";
  }
  if (ngrokError === "ERR_NGROK_108") {
    return "Another ngrok agent is already running with this account. Stop it first.";
  }
  if (ngrokError) {
    return `ngrok failed with ${ngrokError}`;
  }
  const lastLine = log.trim().split(/\r?\n/).pop();
  return lastLine ? `${tool} stopped: ${lastLine.slice(0, 200)}` : `${tool} stopped before the tunnel was ready`;
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("Cancelled"));
      },
      { once: true },
    );
  });
}

export async function stopTunnel(pid: number): Promise<void> {
  try {
    await run("taskkill.exe", ["/PID", String(pid), "/T", "/F"], 10_000);
  } finally {
    const remaining = (await readStoredTunnels()).filter((tunnel) => tunnel.pid !== pid);
    await writeStoredTunnels(remaining);
  }
}

/**
 * Starts a public tunnel to http://localhost:<port>. The process is detached and
 * writes to a log file (not to a pipe), so it keeps running after Raycast closes
 * the command. Resolves with the public URL once the tool prints it.
 */
export async function startTunnel(options: {
  tool: TunnelTool;
  executable: string;
  port: number;
  logDirectory: string;
  signal?: AbortSignal;
}): Promise<StoredTunnel> {
  const { tool, executable, port, logDirectory, signal } = options;
  mkdirSync(logDirectory, { recursive: true });
  const logFile = join(logDirectory, `${tool}-${port}-${Date.now()}.log`);
  const output = openSync(logFile, "a");
  const args =
    tool === "cloudflared"
      ? ["tunnel", "--no-autoupdate", "--url", `http://localhost:${port}`]
      : ["http", String(port), "--log", "stdout", "--log-format", "logfmt"];

  const child = spawn(executable, args, { detached: true, windowsHide: true, stdio: ["ignore", output, output] });
  closeSync(output);
  child.unref();
  const pid = child.pid;
  if (!pid) {
    throw new Error(`Could not start ${tool}`);
  }

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await delay(POLL_INTERVAL_MS, signal);
    const log = readLog(logFile);
    const url = extractTunnelUrl(tool, log);
    if (url) {
      const tunnel: StoredTunnel = { tool, pid, port, url, startedAt: new Date().toISOString(), logFile };
      await writeStoredTunnels([...(await readStoredTunnels()), tunnel]);
      return tunnel;
    }
    if (!isProcessAlive(pid) || NGROK_ERROR.test(log)) {
      if (isProcessAlive(pid)) {
        await run("taskkill.exe", ["/PID", String(pid), "/T", "/F"]).catch(() => undefined);
      }
      throw new Error(explainFailure(tool, log));
    }
  }
  await run("taskkill.exe", ["/PID", String(pid), "/T", "/F"]).catch(() => undefined);
  throw new Error(`${tool} did not report a public URL within ${START_TIMEOUT_MS / 1000} seconds`);
}
