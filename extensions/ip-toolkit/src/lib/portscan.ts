import { lookup } from "node:dns/promises";
import { Socket } from "node:net";

export type PortState = "open" | "closed" | "filtered";

export interface PortResult {
  port: number;
  state: PortState;
  service?: string;
  latencyMs?: number;
}

/** Hard limits keep the scan quick and polite. */
export const MAX_PORTS = 1024;
export const CONCURRENCY = 64;

export const SERVICE_NAMES: Record<number, string> = {
  20: "FTP Data",
  21: "FTP",
  22: "SSH",
  23: "Telnet",
  25: "SMTP",
  53: "DNS",
  67: "DHCP",
  80: "HTTP",
  110: "POP3",
  111: "RPC",
  123: "NTP",
  135: "MS RPC",
  139: "NetBIOS",
  143: "IMAP",
  161: "SNMP",
  179: "BGP",
  389: "LDAP",
  443: "HTTPS",
  445: "SMB",
  465: "SMTPS",
  514: "Syslog",
  587: "SMTP Submission",
  631: "IPP",
  636: "LDAPS",
  853: "DNS over TLS",
  993: "IMAPS",
  995: "POP3S",
  1080: "SOCKS",
  1194: "OpenVPN",
  1433: "SQL Server",
  1521: "Oracle",
  1723: "PPTP",
  1883: "MQTT",
  2049: "NFS",
  3000: "Dev Server",
  3306: "MySQL",
  3389: "RDP",
  5000: "Dev Server",
  5432: "PostgreSQL",
  5900: "VNC",
  5985: "WinRM",
  5986: "WinRM (HTTPS)",
  6379: "Redis",
  8000: "HTTP Alt",
  8080: "HTTP Alt",
  8443: "HTTPS Alt",
  8888: "HTTP Alt",
  9000: "HTTP Alt",
  9090: "Prometheus",
  9200: "Elasticsearch",
  11434: "Ollama",
  27017: "MongoDB",
};

export const COMMON_PORTS = Object.keys(SERVICE_NAMES).map(Number);

/** Parses "22,80,443,8000-8010" into a sorted, de-duplicated port list. */
export function parsePorts(text: string): { ports: number[] } | { error: string } {
  const ports = new Set<number>();
  for (const raw of text.split(/[\s,;]+/).filter(Boolean)) {
    const range = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(raw);
    if (!range) {
      return { error: `"${raw}" is not a port or a range like 8000-8010` };
    }
    const start = Number(range[1]);
    const end = range[2] ? Number(range[2]) : start;
    if (start < 1 || end > 65535 || start > end) {
      return { error: `"${raw}" is outside 1-65535` };
    }
    if (end - start + 1 > MAX_PORTS) {
      return { error: `Scan at most ${MAX_PORTS} ports at a time` };
    }
    for (let port = start; port <= end; port++) {
      ports.add(port);
    }
  }
  if (ports.size === 0) {
    return { error: "Type at least one port" };
  }
  if (ports.size > MAX_PORTS) {
    return { error: `Scan at most ${MAX_PORTS} ports at a time` };
  }
  return { ports: [...ports].sort((a, b) => a - b) };
}

export async function resolveHost(host: string): Promise<string> {
  const { address } = await lookup(host.trim());
  return address;
}

/** A plain TCP connect: open = handshake completed, closed = refused, filtered = no answer. */
export function probePort(address: string, port: number, timeoutMs: number, signal?: AbortSignal): Promise<PortResult> {
  return new Promise((resolve) => {
    const socket = new Socket();
    const started = performance.now();
    let finished = false;

    const finish = (state: PortState) => {
      if (finished) {
        return;
      }
      finished = true;
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      resolve({
        port,
        state,
        service: SERVICE_NAMES[port],
        latencyMs: state === "open" ? Math.round(performance.now() - started) : undefined,
      });
    };
    const onAbort = () => finish("filtered");

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish("open"));
    socket.once("timeout", () => finish("filtered"));
    socket.once("error", (error: NodeJS.ErrnoException) =>
      finish(error.code === "ECONNREFUSED" ? "closed" : "filtered"),
    );
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.connect(port, address);
  });
}

export async function scanPorts(
  address: string,
  ports: number[],
  options: { timeoutMs: number; signal?: AbortSignal; onResult?: (result: PortResult, done: number) => void },
): Promise<PortResult[]> {
  const results: PortResult[] = [];
  let next = 0;
  const worker = async () => {
    while (next < ports.length && !options.signal?.aborted) {
      const port = ports[next++];
      const result = await probePort(address, port, options.timeoutMs, options.signal);
      results.push(result);
      options.onResult?.(result, results.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ports.length) }, worker));
  return results.sort((a, b) => a.port - b.port);
}
