import { isIP } from "node:net";

export type Family = 4 | 6;

export interface SubnetInfo {
  family: Family;
  address: string;
  prefix: number;
  cidr: string;
  network: string;
  /** IPv4 only, and only when the subnet has a broadcast address (/30 or larger). */
  broadcast?: string;
  firstHost: string;
  lastHost: string;
  netmask: string;
  /** IPv4 only. */
  wildcard?: string;
  totalAddresses: bigint;
  usableHosts: bigint;
  addressType: string;
}

export type SubnetResult = { ok: true; info: SubnetInfo } | { ok: false; error: string };

const BITS: Record<Family, number> = { 4: 32, 6: 128 };

export function parseIPv4(text: string): bigint | undefined {
  const parts = text.trim().split(".");
  if (parts.length !== 4) {
    return undefined;
  }
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) {
      return undefined;
    }
    value = (value << 8n) | BigInt(Number(part));
  }
  return value;
}

export function parseIPv6(text: string): bigint | undefined {
  let input = text.trim();
  const zone = input.indexOf("%");
  if (zone >= 0) {
    input = input.slice(0, zone);
  }
  if (isIP(input) !== 6) {
    return undefined;
  }
  // Embedded IPv4 tail, e.g. ::ffff:192.0.2.1 -> ::ffff:c000:201
  const lastColon = input.lastIndexOf(":");
  const tail = input.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseIPv4(tail);
    if (v4 === undefined) {
      return undefined;
    }
    input = `${input.slice(0, lastColon + 1)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const halves = input.split("::");
  if (halves.length > 2) {
    return undefined;
  }
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  let groups = head;
  if (halves.length === 2) {
    const missing = 8 - head.length - rest.length;
    if (missing < 1) {
      return undefined;
    }
    groups = [...head, ...Array<string>(missing).fill("0"), ...rest];
  }
  if (groups.length !== 8) {
    return undefined;
  }
  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) {
      return undefined;
    }
    value = (value << 16n) | BigInt(parseInt(group, 16));
  }
  return value;
}

export function formatIPv4(value: bigint): string {
  return [24n, 16n, 8n, 0n].map((shift) => ((value >> shift) & 255n).toString()).join(".");
}

/** RFC 5952 text form: lower case, longest run of two or more zero groups compressed. */
export function formatIPv6(value: bigint): string {
  const groups = Array.from({ length: 8 }, (_, index) => Number((value >> BigInt(112 - index * 16)) & 0xffffn));
  let bestStart = -1;
  let bestLength = 0;
  let index = 0;
  while (index < 8) {
    if (groups[index] === 0) {
      let end = index;
      while (end < 8 && groups[end] === 0) {
        end++;
      }
      if (end - index > bestLength) {
        bestStart = index;
        bestLength = end - index;
      }
      index = end;
    } else {
      index++;
    }
  }
  const hex = groups.map((group) => group.toString(16));
  if (bestLength < 2) {
    return hex.join(":");
  }
  return `${hex.slice(0, bestStart).join(":")}::${hex.slice(bestStart + bestLength).join(":")}`;
}

function format(family: Family, value: bigint): string {
  return family === 4 ? formatIPv4(value) : formatIPv6(value);
}

function maskFor(family: Family, prefix: number): bigint {
  const bits = BITS[family];
  const all = (1n << BigInt(bits)) - 1n;
  return prefix === 0 ? 0n : (all << BigInt(bits - prefix)) & all;
}

/** Converts a dotted netmask to a prefix length; undefined when the bits are not contiguous. */
export function netmaskToPrefix(text: string): number | undefined {
  const mask = parseIPv4(text);
  if (mask === undefined) {
    return undefined;
  }
  const inverted = ~mask & 0xffffffffn;
  if ((inverted & (inverted + 1n)) !== 0n) {
    return undefined;
  }
  return 32 - inverted.toString(2).replace(/0/g, "").length;
}

function within(family: Family, value: bigint, base: string, prefix: number): boolean {
  const baseValue = family === 4 ? parseIPv4(base) : parseIPv6(base);
  if (baseValue === undefined) {
    return false;
  }
  const mask = maskFor(family, prefix);
  return (value & mask) === (baseValue & mask);
}

const IPV4_TYPES: [string, number, string][] = [
  ["0.0.0.0", 8, "This Network"],
  ["10.0.0.0", 8, "Private (RFC 1918)"],
  ["100.64.0.0", 10, "Carrier-Grade NAT (RFC 6598)"],
  ["127.0.0.0", 8, "Loopback"],
  ["169.254.0.0", 16, "Link-Local"],
  ["172.16.0.0", 12, "Private (RFC 1918)"],
  ["192.0.2.0", 24, "Documentation (TEST-NET-1)"],
  ["192.168.0.0", 16, "Private (RFC 1918)"],
  ["198.18.0.0", 15, "Benchmarking"],
  ["198.51.100.0", 24, "Documentation (TEST-NET-2)"],
  ["203.0.113.0", 24, "Documentation (TEST-NET-3)"],
  ["224.0.0.0", 4, "Multicast"],
  ["255.255.255.255", 32, "Limited Broadcast"],
  ["240.0.0.0", 4, "Reserved"],
];

const IPV6_TYPES: [string, number, string][] = [
  ["::", 128, "Unspecified"],
  ["::1", 128, "Loopback"],
  ["::ffff:0:0", 96, "IPv4-Mapped"],
  ["64:ff9b::", 96, "NAT64"],
  ["2001:db8::", 32, "Documentation"],
  ["2002::", 16, "6to4"],
  ["fc00::", 7, "Unique Local (ULA)"],
  ["fe80::", 10, "Link-Local"],
  ["ff00::", 8, "Multicast"],
  ["2000::", 3, "Global Unicast"],
];

export function classifyAddress(family: Family, value: bigint): string {
  const table = family === 4 ? IPV4_TYPES : IPV6_TYPES;
  const match = table.find(([base, prefix]) => within(family, value, base, prefix));
  if (match) {
    return match[2];
  }
  return family === 4 ? "Public" : "Reserved";
}

/**
 * Accepts "192.168.0.10/24", "192.168.0.10/255.255.255.0", "192.168.0.10 255.255.255.0",
 * "2001:db8::1/48" or a bare address (treated as a single host).
 */
export function calculateSubnet(input: string): SubnetResult {
  const text = input.trim();
  if (!text) {
    return { ok: false, error: "Type an address such as 192.168.0.10/24 or 2001:db8::/48" };
  }
  const [addressPart, maskPart, ...extra] = text.split(/\s*\/\s*|\s+/);
  if (extra.length > 0) {
    return { ok: false, error: "Use the form address/prefix, e.g. 10.0.0.1/16" };
  }
  const family: Family | undefined =
    isIP(addressPart.split("%")[0]) === 4 ? 4 : isIP(addressPart.split("%")[0]) === 6 ? 6 : undefined;
  if (!family) {
    return { ok: false, error: `"${addressPart}" is not a valid IPv4 or IPv6 address` };
  }
  const value = family === 4 ? parseIPv4(addressPart) : parseIPv6(addressPart);
  if (value === undefined) {
    return { ok: false, error: `"${addressPart}" is not a valid address` };
  }
  const bits = BITS[family];
  let prefix = bits;
  if (maskPart !== undefined) {
    if (/^\d{1,3}$/.test(maskPart)) {
      prefix = Number(maskPart);
    } else if (family === 4 && maskPart.includes(".")) {
      const fromMask = netmaskToPrefix(maskPart);
      if (fromMask === undefined) {
        return { ok: false, error: `"${maskPart}" is not a valid netmask (bits must be contiguous)` };
      }
      prefix = fromMask;
    } else {
      return { ok: false, error: `"${maskPart}" is not a valid prefix length` };
    }
    if (prefix < 0 || prefix > bits) {
      return { ok: false, error: `The prefix must be between 0 and ${bits}` };
    }
  }

  const mask = maskFor(family, prefix);
  const all = (1n << BigInt(bits)) - 1n;
  const network = value & mask;
  const last = network | (~mask & all);
  const totalAddresses = 1n << BigInt(bits - prefix);

  let firstHost = network;
  let lastHost = last;
  let usableHosts = totalAddresses;
  let broadcast: string | undefined;
  if (family === 4 && prefix <= 30) {
    // Network and broadcast addresses are not assignable. /31 (RFC 3021) and /32 keep every address.
    firstHost = network + 1n;
    lastHost = last - 1n;
    usableHosts = totalAddresses - 2n;
    broadcast = formatIPv4(last);
  }

  return {
    ok: true,
    info: {
      family,
      address: format(family, value),
      prefix,
      cidr: `${format(family, network)}/${prefix}`,
      network: format(family, network),
      broadcast,
      firstHost: format(family, firstHost),
      lastHost: format(family, lastHost),
      netmask: family === 4 ? formatIPv4(mask) : `/${prefix}`,
      wildcard: family === 4 ? formatIPv4(~mask & all) : undefined,
      totalAddresses,
      usableHosts,
      addressType: classifyAddress(family, value),
    },
  };
}

/** 4294967296 -> "4,294,967,296"; huge IPv6 counts also get the power of two. */
export function formatCount(count: bigint): string {
  const text = count.toLocaleString("en-US");
  if (count > 1_000_000_000_000n) {
    const power = count.toString(2).length - 1;
    return `2^${power} (${text})`;
  }
  return text;
}
