import { isIP } from "node:net";

export type RdapKind = "ip" | "domain" | "autnum";

export interface RdapEvent {
  action: string;
  date: string;
}

export interface RdapSummary {
  kind: RdapKind;
  query: string;
  url: string;
  handle?: string;
  name?: string;
  type?: string;
  country?: string;
  range?: string;
  cidrs: string[];
  status: string[];
  registrant?: string;
  registrar?: string;
  abuseEmails: string[];
  nameservers: string[];
  events: RdapEvent[];
  remarks: string[];
  port43?: string;
  raw: unknown;
}

/** rdap.org redirects each query to the authoritative registry (RIR or TLD) via the IANA bootstrap. */
const RDAP_BASE = "https://rdap.org";
const TIMEOUT_MS = 15_000;
/** rdap.org answers 403 to the default Node.js user agent, so identify the extension instead. */
const USER_AGENT = "Raycast-IP-Toolkit/1.0 (+https://www.raycast.com/veilwalker/ip-toolkit)";

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function classifyQuery(input: string): { kind: RdapKind; value: string } | undefined {
  const text = input.trim();
  if (!text) {
    return undefined;
  }
  if (isIP(text)) {
    return { kind: "ip", value: text };
  }
  const asn = /^(?:as)?(\d{1,10})$/i.exec(text);
  if (asn) {
    return { kind: "autnum", value: asn[1] };
  }
  const domain = text
    .replace(/^[a-z]+:\/\//i, "")
    .split(/[/?#]/)[0]
    .replace(/\.$/, "")
    .toLowerCase();
  if (/^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z0-9-]{2,63}$/i.test(domain)) {
    return { kind: "domain", value: domain };
  }
  return undefined;
}

/** Reads a field such as "fn" or "email" from a jCard (RFC 7095) array. */
function vcardValues(entity: Json, field: string): string[] {
  const vcard = asList(entity.vcardArray);
  return asList(vcard[1])
    .filter((entry): entry is unknown[] => Array.isArray(entry) && entry[0] === field)
    .map((entry) => asString(entry[3]))
    .filter((value): value is string => Boolean(value));
}

function walkEntities(entities: unknown, visit: (entity: Json, roles: string[]) => void) {
  for (const entity of asList(entities)) {
    if (!isObject(entity)) {
      continue;
    }
    visit(
      entity,
      asList(entity.roles).filter((role): role is string => typeof role === "string"),
    );
    walkEntities(entity.entities, visit);
  }
}

export function summarize(kind: RdapKind, query: string, url: string, data: Json): RdapSummary {
  let registrant: string | undefined;
  let registrar: string | undefined;
  const abuseEmails = new Set<string>();
  walkEntities(data.entities, (entity, roles) => {
    const name = vcardValues(entity, "fn")[0];
    if (roles.includes("registrant") && !registrant) {
      registrant = name;
    }
    if (roles.includes("registrar") && !registrar) {
      registrar = name;
    }
    if (roles.includes("abuse")) {
      vcardValues(entity, "email").forEach((email) => abuseEmails.add(email));
    }
  });

  const cidrs = asList(data.cidr0_cidrs)
    .filter(isObject)
    .map((cidr) => {
      const prefix = asString(cidr.v4prefix) ?? asString(cidr.v6prefix);
      return prefix ? `${prefix}/${String(cidr.length)}` : undefined;
    })
    .filter((value): value is string => Boolean(value));

  const start = asString(data.startAddress);
  const end = asString(data.endAddress);
  const asnStart = typeof data.startAutnum === "number" ? data.startAutnum : undefined;
  const asnEnd = typeof data.endAutnum === "number" ? data.endAutnum : undefined;
  let range: string | undefined;
  if (start && end) {
    range = `${start} - ${end}`;
  } else if (asnStart !== undefined) {
    range = asnEnd !== undefined && asnEnd !== asnStart ? `AS${asnStart} - AS${asnEnd}` : `AS${asnStart}`;
  }

  return {
    kind,
    query,
    url,
    handle: asString(data.handle),
    name: asString(data.name) ?? asString(data.ldhName),
    type: asString(data.type),
    country: asString(data.country),
    range,
    cidrs,
    status: asList(data.status).filter((value): value is string => typeof value === "string"),
    registrant,
    registrar,
    abuseEmails: [...abuseEmails],
    nameservers: asList(data.nameservers)
      .filter(isObject)
      .map((server) => asString(server.ldhName)?.toLowerCase())
      .filter((value): value is string => Boolean(value)),
    events: asList(data.events)
      .filter(isObject)
      .map((event) => ({ action: asString(event.eventAction) ?? "", date: asString(event.eventDate) ?? "" }))
      .filter((event) => event.action && event.date),
    remarks: asList(data.remarks)
      .filter(isObject)
      .flatMap((remark) => asList(remark.description).filter((line): line is string => typeof line === "string")),
    port43: asString(data.port43),
    raw: data,
  };
}

export async function rdapLookup(input: string, signal?: AbortSignal): Promise<RdapSummary> {
  const target = classifyQuery(input);
  if (!target) {
    throw new Error(`"${input}" is not an IP address, domain or AS number`);
  }
  const url = `${RDAP_BASE}/${target.kind}/${encodeURIComponent(target.value)}`;
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const response = await fetch(url, {
    headers: { Accept: "application/rdap+json, application/json", "User-Agent": USER_AGENT },
    redirect: "follow",
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (response.status === 404) {
    throw new Error(`No registration data found for ${target.value}`);
  }
  if (!response.ok) {
    throw new Error(`The registry answered with HTTP ${response.status}`);
  }
  const data: unknown = await response.json();
  if (!isObject(data)) {
    throw new Error("The registry returned an unexpected answer");
  }
  return summarize(target.kind, target.value, response.url || url, data);
}
