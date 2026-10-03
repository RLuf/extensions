import { networkInterfaces } from "node:os";
import { getDefaultRouteAddress } from "./local-ip";
import { getPublicIP, type IPVersion } from "./public-ip";

export type IPScope = "external" | "internal";

export interface MyIP {
  ip: string;
  /** Human label used in toasts and HUDs, e.g. "external IPv4". */
  label: string;
}

/** Normalizes the optional dropdown argument: anything other than "internal" means external. */
export function parseScope(value: string | undefined): IPScope {
  return value === "internal" ? "internal" : "external";
}

/**
 * Returns the primary internal address of the requested family: the
 * default-route address when it can be detected, otherwise the first
 * non-loopback, non-link-local address reported by the OS.
 */
export async function getInternalIP(version: IPVersion): Promise<string> {
  const family = version === "ipv4" ? "IPv4" : "IPv6";
  const routed = await getDefaultRouteAddress(family);
  if (routed) {
    return routed;
  }
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== family) {
        continue;
      }
      if (family === "IPv6" && entry.address.toLowerCase().startsWith("fe80:")) {
        continue;
      }
      return entry.address;
    }
  }
  throw new Error(`No internal ${family} address found on this machine`);
}

export async function getMyIP(scope: IPScope, version: IPVersion): Promise<MyIP> {
  const family = version === "ipv4" ? "IPv4" : "IPv6";
  if (scope === "internal") {
    return { ip: await getInternalIP(version), label: `internal ${family}` };
  }
  const { ip } = await getPublicIP(version);
  return { ip, label: `external ${family}` };
}
