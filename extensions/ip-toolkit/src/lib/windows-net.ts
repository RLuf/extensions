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

export interface TunnelAdapter {
  /** Name shown in Windows, e.g. "Ethernet 3". Users can rename it. */
  alias: string;
  /** Driver description, e.g. "TAP-Windows Adapter V9" or "WireGuard Tunnel". */
  description?: string;
}

export interface NetworkDetails {
  gateways: DefaultGateway[];
  dns: DnsServers[];
  wifi: WifiConnection[];
  /**
   * Virtual tunnel adapters (TUN/TAP, Wintun, WireGuard...) that hold a default route.
   * This only shows that internet traffic leaves through a tunnel; it says nothing
   * about what is on the other end.
   */
  tunnelAdapters: TunnelAdapter[];
  tunnels: RunningProcess[];
}

/**
 * Fragments of tunnel driver descriptions and adapter names. Checked against both,
 * because clients such as OpenVPN create an adapter named "Ethernet 3" whose only
 * tell is the driver description. A heuristic, not a guarantee.
 */
const TUNNEL_ADAPTER_PATTERN =
  /wintun|wireguard|tap-windows|\btap\b|\btun\b|openvpn|cloudflare ?warp|tailscale|zerotier|nordlynx|fortinet|globalprotect|anyconnect|pangp|vpn/i;

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
$adapters = @()
if ($indexes.Count -gt 0) {
  $dns = @(Get-DnsClientServerAddress -InterfaceIndex $indexes -ErrorAction SilentlyContinue |
    Select-Object InterfaceAlias, InterfaceIndex, AddressFamily, ServerAddresses)
  $adapters = @(Get-NetAdapter -InterfaceIndex $indexes -IncludeHidden -ErrorAction SilentlyContinue |
    Select-Object InterfaceIndex, InterfaceDescription)
}
@{ routes = $routes; dns = $dns; adapters = $adapters } | ConvertTo-Json -Compress -Depth 4
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

/** Windows PowerShell serializes the AddressFamily enum as 2 (IPv4) or 23 (IPv6). */
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

interface RawAdapter {
  InterfaceIndex?: number;
  InterfaceDescription?: string;
}

export interface RouteAndDns {
  gateways: DefaultGateway[];
  dns: DnsServers[];
  /** Driver description by interface index, for the interfaces holding a default route. */
  descriptions: Record<number, string>;
}

export function parseRouteAndDns(json: string): RouteAndDns {
  const trimmed = json.trim();
  if (!trimmed) {
    return { gateways: [], dns: [], descriptions: {} };
  }
  const parsed = JSON.parse(trimmed) as {
    routes?: RawRoute | RawRoute[];
    dns?: RawDns | RawDns[];
    adapters?: RawAdapter | RawAdapter[];
  };
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
  const descriptions: Record<number, string> = {};
  for (const adapter of asArray(parsed.adapters)) {
    if (typeof adapter.InterfaceIndex === "number" && adapter.InterfaceDescription) {
      descriptions[adapter.InterfaceIndex] = adapter.InterfaceDescription;
    }
  }
  return { gateways, dns, descriptions };
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

async function getRouteAndDns(): Promise<RouteAndDns> {
  try {
    return parseRouteAndDns(await runPowerShell(ROUTE_AND_DNS_SCRIPT));
  } catch {
    return { gateways: [], dns: [], descriptions: {} };
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

export function isTunnelAdapter(alias: string, description?: string): boolean {
  return TUNNEL_ADAPTER_PATTERN.test(alias) || (description !== undefined && TUNNEL_ADAPTER_PATTERN.test(description));
}

/** Default-route interfaces whose name or driver description looks like a tunnel adapter. */
export function findTunnelAdapters(gateways: DefaultGateway[], descriptions: Record<number, string>): TunnelAdapter[] {
  const seen = new Set<number>();
  const adapters: TunnelAdapter[] = [];
  for (const gateway of gateways) {
    if (seen.has(gateway.interfaceIndex)) {
      continue;
    }
    seen.add(gateway.interfaceIndex);
    const description = descriptions[gateway.interfaceIndex];
    if (isTunnelAdapter(gateway.interfaceAlias, description)) {
      adapters.push({ alias: gateway.interfaceAlias, description });
    }
  }
  return adapters;
}

/** Gateway, DNS, Wi-Fi and tunnel information. Every part degrades to empty on failure. */
export async function getNetworkDetails(): Promise<NetworkDetails> {
  const [{ gateways, dns, descriptions }, wifi, tunnels] = await Promise.all([
    getRouteAndDns(),
    getWifi(),
    getTunnelProcesses(),
  ]);
  return { gateways, dns, wifi, tunnelAdapters: findTunnelAdapters(gateways, descriptions), tunnels };
}
