import { createSocket } from "node:dgram";
import { hostname, networkInterfaces } from "node:os";

export type IPFamily = "IPv4" | "IPv6";

export interface LocalAddress {
  /** Adapter name as reported by the OS, e.g. "Ethernet" or "Wi-Fi". */
  interfaceName: string;
  address: string;
  family: IPFamily;
  netmask: string;
  /** Address with prefix length, e.g. "192.168.0.10/24". Missing when the OS reports an unparseable netmask. */
  cidr?: string;
  mac: string;
  /** IPv6 zone index, only for link-local addresses. */
  scopeId?: number;
  /** True for the address that currently reaches the internet (default route). */
  isDefaultRoute: boolean;
}

export interface LocalNetworkInfo {
  hostname: string;
  addresses: LocalAddress[];
}

const PROBE_TIMEOUT_MS = 1500;

/** Strips an IPv6 zone suffix such as "%eth0" or "%18" so addresses compare by value. */
function stripZone(address: string): string {
  const zone = address.indexOf("%");
  return zone === -1 ? address : address.slice(0, zone);
}

/**
 * Finds the local address used for outbound traffic by "connecting" a UDP
 * socket to a public resolver address. No packet is sent: the OS only picks
 * the route. Resolves to undefined when there is no route (offline).
 */
export function getDefaultRouteAddress(family: IPFamily = "IPv4"): Promise<string | undefined> {
  return new Promise((resolve) => {
    const socket = createSocket(family === "IPv4" ? "udp4" : "udp6");
    let settled = false;
    const finish = (value: string | undefined) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.close();
      resolve(value);
    };
    const timer = setTimeout(() => finish(undefined), PROBE_TIMEOUT_MS);
    socket.once("error", () => finish(undefined));
    try {
      socket.connect(53, family === "IPv4" ? "1.1.1.1" : "2606:4700:4700::1111", (error?: Error) => {
        if (error) {
          finish(undefined);
          return;
        }
        try {
          finish(stripZone(socket.address().address));
        } catch {
          finish(undefined);
        }
      });
    } catch {
      finish(undefined);
    }
  });
}

/**
 * Lists every non-loopback address of the machine, IPv4 first, with the
 * default-route address at the top of each family.
 */
export async function getLocalNetworkInfo(): Promise<LocalNetworkInfo> {
  const [defaultV4, defaultV6] = await Promise.all([getDefaultRouteAddress("IPv4"), getDefaultRouteAddress("IPv6")]);

  const addresses: LocalAddress[] = [];
  for (const [interfaceName, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal) {
        continue;
      }
      const isLinkLocalV6 = entry.family === "IPv6" && entry.address.toLowerCase().startsWith("fe80:");
      const bareAddress = stripZone(entry.address);
      addresses.push({
        interfaceName,
        address: entry.address,
        family: entry.family,
        netmask: entry.netmask,
        cidr: entry.cidr ?? undefined,
        mac: entry.mac,
        scopeId: isLinkLocalV6 && entry.scopeid > 0 ? entry.scopeid : undefined,
        isDefaultRoute: entry.family === "IPv4" ? bareAddress === defaultV4 : bareAddress === defaultV6,
      });
    }
  }

  addresses.sort((a, b) => {
    if (a.family !== b.family) {
      return a.family === "IPv4" ? -1 : 1;
    }
    if (a.isDefaultRoute !== b.isDefaultRoute) {
      return a.isDefaultRoute ? -1 : 1;
    }
    return a.interfaceName.localeCompare(b.interfaceName);
  });

  return { hostname: hostname(), addresses };
}
