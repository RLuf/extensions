import { execFile } from "node:child_process";

export type AddressFamilyName = "IPv4" | "IPv6";

export interface DefaultGateway {
  interfaceAlias: string;
  interfaceIndex: number;
  gateway: string;
  family: AddressFamilyName;
  metric: number;
}

export interface DnsServers {
  interfaceAlias: string;
  interfaceIndex: number;
  family: AddressFamilyName;
  servers: string[];
}

export interface WifiConnection {
  interfaceName: string;
  ssid: string;
  /** Signal quality in percent, as reported by Windows. */
  signal?: number;
}

export interface RunningProcess {
  name: string;
  pid: number;
}

export interface NetworkDetails {
  gateways: DefaultGateway[];
  dns: DnsServers[];
  wifi: WifiConnection[];
  /** Adapter names that look like a VPN and currently hold a default route. */
  vpnAdapters: string[];
  tunnels: RunningProcess[];
}

/** Adapter name fragments of common VPN clients. A heuristic, not a guarantee. */
const VPN_ADAPTER_PATTERN =
  /vpn|wireguard|wintun|openvpn|tap-windows|\btap\b|\btun\b|tailscale|zerotier|nordlynx|proton|mullvad|cloudflare warp|fortinet|globalprotect|anyconnect|pangp/i;

/** Executables that open public tunnels to this machine. */
const TUNNEL_EXECUTABLES = ["cloudflared.exe", "ngrok.exe"];

/**
 * Two CIM queries instead of Get-NetIPConfiguration: that cmdlet walks every
 * adapter (virtual ones included) and takes about 4.5 s; this takes about 1.4 s.
 */
const ROUTE_AND_DNS_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$routes = @(Get-NetRoute -DestinationPrefix '0.0.0.0/0','::/0' -ErrorAction SilentlyContinue |
  Sort-Object RouteMetric |
  Select-Object InterfaceAlias, InterfaceIndex, NextHop, AddressFamily, RouteMetric)
$indexes = @($routes | Select-Object -ExpandProperty InterfaceIndex -Unique)
$dns = @()
if ($indexes.Count -gt 0) {
  $dns = @(Get-DnsClientServerAddress -InterfaceIndex $indexes -ErrorAction SilentlyContinue |
    Select-Object InterfaceAlias, InterfaceIndex, AddressFamily, ServerAddresses)
}
@{ routes = $routes; dns = $dns } | ConvertTo-Json -Compress -Depth 4
`;

export function run(file: string, args: string[], timeout = 8000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
      (error, stdout) => {
        if (error) {
          reject(error);
        } else {
          resolve(stdout);
        }
      },
    );
  });
}

function runPowerShell(script: string, timeout = 8000): Promise<string> {
  // -EncodedCommand avoids every quoting problem: the script travels as UTF-16LE Base64.
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return run(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
    timeout,
  );
}

function asArray<T>(value: T | T[] | null | undefined): T[] {
  if (value === null || value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

/** Windows PowerShell serialises the AddressFamily enum as 2 (IPv4) or 23 (IPv6). */
function toFamily(value: unknown): AddressFamilyName {
  return value === 23 || value === "IPv6" || value === "InterNetworkV6" ? "IPv6" : "IPv4";
}

interface RawRoute {
  InterfaceAlias?: string;
  InterfaceIndex?: number;
  NextHop?: string;
  AddressFamily?: unknown;
  RouteMetric?: number;
}

interface RawDns {
  InterfaceAlias?: string;
  InterfaceIndex?: number;
  AddressFamily?: unknown;
  ServerAddresses?: string | string[] | null;
}

export function parseRouteAndDns(json: string): { gateways: DefaultGateway[]; dns: DnsServers[] } {
  const trimmed = json.trim();
  if (!trimmed) {
    return { gateways: [], dns: [] };
  }
  const parsed = JSON.parse(trimmed) as { routes?: RawRoute | RawRoute[]; dns?: RawDns | RawDns[] };
  const gateways = asArray(parsed.routes)
    .filter((route) => route.NextHop && route.NextHop !== "0.0.0.0" && route.NextHop !== "::")
    .map((route) => ({
      interfaceAlias: route.InterfaceAlias ?? "Unknown",
      interfaceIndex: route.InterfaceIndex ?? -1,
      gateway: route.NextHop as string,
      family: toFamily(route.AddressFamily),
      metric: route.RouteMetric ?? 0,
    }));
  const dns = asArray(parsed.dns)
    .map((entry) => ({
      interfaceAlias: entry.InterfaceAlias ?? "Unknown",
      interfaceIndex: entry.InterfaceIndex ?? -1,
      family: toFamily(entry.AddressFamily),
      servers: asArray(entry.ServerAddresses).filter((server) => typeof server === "string" && server.length > 0),
    }))
    .filter((entry) => entry.servers.length > 0);
  return { gateways, dns };
}

/**
 * Parses `netsh wlan show interfaces`. The labels are translated by Windows, so
 * only language-neutral markers are used: the "SSID" label (never translated)
 * and the value ending in "%" (signal).
 */
export function parseWlanInterfaces(output: string): WifiConnection[] {
  const connections: WifiConnection[] = [];
  for (const block of output.split(/\r?\n\s*\r?\n/)) {
    const lines = block.split(/\r?\n/).filter((line) => line.includes(":"));
    const ssidLine = lines.find((line) => /^\s*SSID\s*:/.test(line));
    const ssid = ssidLine?.slice(ssidLine.indexOf(":") + 1).trim();
    if (!ssid) {
      continue;
    }
    const firstLine = lines[0];
    const interfaceName = firstLine ? firstLine.slice(firstLine.indexOf(":") + 1).trim() : "Wi-Fi";
    const signalMatch = lines.map((line) => /:\s*(\d{1,3})\s*%\s*$/.exec(line)).find(Boolean);
    connections.push({ interfaceName, ssid, signal: signalMatch ? Number(signalMatch[1]) : undefined });
  }
  return connections;
}

/** Parses `tasklist /FO CSV /NH`: "Image Name","PID",... */
export function parseTasklist(output: string): RunningProcess[] {
  const processes: RunningProcess[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^"([^"]+)","(\d+)"/.exec(line.trim());
    if (match) {
      processes.push({ name: match[1], pid: Number(match[2]) });
    }
  }
  return processes;
}

export async function listProcesses(): Promise<RunningProcess[]> {
  try {
    return parseTasklist(await run("tasklist.exe", ["/FO", "CSV", "/NH"]));
  } catch {
    return [];
  }
}

export async function getTunnelProcesses(): Promise<RunningProcess[]> {
  const processes = await listProcesses();
  return processes.filter((process) => TUNNEL_EXECUTABLES.includes(process.name.toLowerCase()));
}

async function getRouteAndDns(): Promise<{ gateways: DefaultGateway[]; dns: DnsServers[] }> {
  try {
    return parseRouteAndDns(await runPowerShell(ROUTE_AND_DNS_SCRIPT));
  } catch {
    return { gateways: [], dns: [] };
  }
}

async function getWifi(): Promise<WifiConnection[]> {
  try {
    return parseWlanInterfaces(await run("netsh.exe", ["wlan", "show", "interfaces"], 5000));
  } catch {
    // No wireless adapter, or the WLAN AutoConfig service is stopped.
    return [];
  }
}

export function isVpnAdapter(name: string): boolean {
  return VPN_ADAPTER_PATTERN.test(name);
}

/** Gateway, DNS, Wi-Fi and tunnel information. Every part degrades to empty on failure. */
export async function getNetworkDetails(): Promise<NetworkDetails> {
  const [{ gateways, dns }, wifi, tunnels] = await Promise.all([getRouteAndDns(), getWifi(), getTunnelProcesses()]);
  const vpnAdapters = [...new Set(gateways.map((gateway) => gateway.interfaceAlias).filter(isVpnAdapter))];
  return { gateways, dns, wifi, vpnAdapters, tunnels };
}
