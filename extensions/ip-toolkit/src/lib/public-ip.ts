import { request } from "node:https";
import { isIP } from "node:net";

export type IPVersion = "ipv4" | "ipv6";

export interface PublicIPResult {
  ip: string;
  /** Host name of the service that answered, e.g. "ip.me". */
  source: string;
}

interface Service {
  url: string;
  /** Converts the raw HTTP body into an IP string (or undefined when unusable). */
  parse: (body: string) => string | undefined;
}

/** Time a single service gets before it is abandoned. */
const HOP_TIMEOUT_MS = 4000;
/** After this long without an answer the next service is started in parallel (hedging). */
const HEDGE_DELAY_MS = 1500;
/** Upper bound for the whole lookup, all services included. */
const TOTAL_BUDGET_MS = 10000;
/** Public IP answers are a few bytes; anything bigger is not what we asked for. */
const MAX_BODY_BYTES = 4096;

/**
 * ip.me answers with plain text only for curl-like user agents; browsers get HTML.
 * The extension name is appended so the service can still identify the client.
 */
const USER_AGENT = "curl/8.0 ip-toolkit (Raycast extension)";

const plainText = (body: string) => body.trim();

/** ip4only.me / ip6only.me answer a CSV line: `IPv4,203.0.113.7,v1.1,,,message`. */
const csvSecondField = (body: string) => body.trim().split(",")[1]?.trim();

const SERVICES: Record<IPVersion, Service[]> = {
  ipv4: [
    { url: "https://ip.me", parse: plainText },
    { url: "https://ip4only.me/api/", parse: csvSecondField },
    { url: "https://api.ipify.org", parse: plainText },
    { url: "https://checkip.amazonaws.com", parse: plainText },
  ],
  ipv6: [
    { url: "https://ip.me", parse: plainText },
    { url: "https://ip6only.me/api/", parse: csvSecondField },
    { url: "https://api6.ipify.org", parse: plainText },
    { url: "https://ipv6.icanhazip.com", parse: plainText },
  ],
};

export function isValidIP(value: string, version: IPVersion): boolean {
  return isIP(value) === (version === "ipv4" ? 4 : 6);
}

export function serviceHost(url: string): string {
  return new URL(url).host;
}

/**
 * GET a small text document over HTTPS, pinning the IP family of the connection
 * so an IPv4 lookup never travels over IPv6 (and vice versa) on dual-stack hosts.
 */
function fetchText(url: string, family: 4 | 6, signal: AbortSignal): Promise<{ ok: boolean; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      { method: "GET", family, signal, headers: { "User-Agent": USER_AGENT, Accept: "text/plain" } },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) {
            req.destroy(new Error(`Response from ${url} is too large`));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          const status = response.statusCode ?? 0;
          resolve({ ok: status >= 200 && status < 300, body: Buffer.concat(chunks).toString("utf8") });
        });
        response.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function queryService(service: Service, version: IPVersion, signal: AbortSignal): Promise<PublicIPResult> {
  const hopSignal = AbortSignal.any([signal, AbortSignal.timeout(HOP_TIMEOUT_MS)]);
  const { ok, body } = await fetchText(service.url, version === "ipv4" ? 4 : 6, hopSignal);
  if (!ok) {
    throw new Error(`${serviceHost(service.url)} answered with an error`);
  }
  const ip = service.parse(body);
  if (!ip || !isValidIP(ip, version)) {
    throw new Error(`${serviceHost(service.url)} did not return a valid ${version === "ipv4" ? "IPv4" : "IPv6"}`);
  }
  return { ip, source: serviceHost(service.url) };
}

function noAnswerError(version: IPVersion): Error {
  return new Error(
    version === "ipv4"
      ? "Could not get your public IPv4. Check your internet connection."
      : "No public IPv6 detected. Your network may not have IPv6 connectivity.",
  );
}

/**
 * Resolves the machine's public (WAN) IP. ip.me is asked first; if it has not
 * answered after a short delay the next service is started in parallel (hedging),
 * the first valid answer wins and every other request is aborted. The whole
 * lookup is bounded by TOTAL_BUDGET_MS and can be cancelled through `signal`.
 */
export function getPublicIP(version: IPVersion = "ipv4", signal?: AbortSignal): Promise<PublicIPResult> {
  const services = SERVICES[version];
  const winner = new AbortController();
  const budget = AbortSignal.timeout(TOTAL_BUDGET_MS);
  const lookup = AbortSignal.any(signal ? [signal, budget, winner.signal] : [budget, winner.signal]);

  return new Promise<PublicIPResult>((resolve, reject) => {
    let settled = false;
    let started = 0;
    let inFlight = 0;
    let hedgeTimer: ReturnType<typeof setTimeout> | undefined;

    const onAbort = () => {
      finish(undefined, signal?.aborted ? new Error("Lookup cancelled") : noAnswerError(version));
    };

    const finish = (result?: PublicIPResult, error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(hedgeTimer);
      lookup.removeEventListener("abort", onAbort);
      winner.abort();
      if (result) {
        resolve(result);
      } else {
        reject(error ?? noAnswerError(version));
      }
    };

    const startNext = () => {
      clearTimeout(hedgeTimer);
      if (settled || started >= services.length) {
        return;
      }
      const service = services[started++];
      inFlight++;
      queryService(service, version, lookup)
        .then((result) => finish(result))
        .catch(() => {
          inFlight--;
          if (settled) {
            return;
          }
          if (started < services.length) {
            startNext();
          } else if (inFlight === 0) {
            finish(undefined, noAnswerError(version));
          }
        });
      if (started < services.length) {
        hedgeTimer = setTimeout(startNext, HEDGE_DELAY_MS);
      }
    };

    lookup.addEventListener("abort", onAbort, { once: true });
    if (lookup.aborted) {
      onAbort();
      return;
    }

    startNext();
  });
}

/**
 * "confirmed": at least two services returned the same address.
 * "mismatch": services disagreed (multi-WAN, load-balanced NAT or a proxy in the path).
 * "single": only one service answered, so nothing could be cross-checked.
 */
export type Agreement = "confirmed" | "mismatch" | "single";

export interface PublicIPConsensus extends PublicIPResult {
  agreement: Agreement;
  /** Every service that reported `ip`. */
  confirmedBy: string[];
  /** Every answer received, in arrival order. */
  answers: PublicIPResult[];
}

/**
 * Asks every service at once and stops as soon as two of them agree. When fewer
 * than two agree, waits for all answers (bounded by TOTAL_BUDGET_MS) and returns
 * the most reported address with an honest agreement flag.
 */
export function getPublicIPConsensus(version: IPVersion = "ipv4", signal?: AbortSignal): Promise<PublicIPConsensus> {
  const services = SERVICES[version];
  const done = new AbortController();
  const budget = AbortSignal.timeout(TOTAL_BUDGET_MS);
  const lookup = AbortSignal.any(signal ? [signal, budget, done.signal] : [budget, done.signal]);
  const answers: PublicIPResult[] = [];

  return new Promise<PublicIPConsensus>((resolve, reject) => {
    let settled = false;
    let pending = services.length;

    const settle = () => {
      if (settled) {
        return;
      }
      settled = true;
      lookup.removeEventListener("abort", settle);
      done.abort();
      if (answers.length === 0) {
        reject(signal?.aborted ? new Error("Lookup cancelled") : noAnswerError(version));
        return;
      }
      const groups = new Map<string, PublicIPResult[]>();
      for (const answer of answers) {
        groups.set(answer.ip, [...(groups.get(answer.ip) ?? []), answer]);
      }
      // Stable sort: on a tie the address that arrived first wins.
      const [ip, group] = [...groups.entries()].sort((a, b) => b[1].length - a[1].length)[0];
      const agreement: Agreement = groups.size > 1 ? "mismatch" : group.length >= 2 ? "confirmed" : "single";
      resolve({
        ip,
        source: group[0].source,
        agreement,
        confirmedBy: group.map((answer) => answer.source),
        answers: [...answers],
      });
    };

    lookup.addEventListener("abort", settle, { once: true });
    if (lookup.aborted) {
      settle();
      return;
    }

    for (const service of services) {
      queryService(service, version, lookup)
        .then((result) => {
          if (settled) {
            return;
          }
          answers.push(result);
          if (answers.filter((answer) => answer.ip === result.ip).length >= 2) {
            settle();
          }
        })
        .catch(() => undefined)
        .finally(() => {
          pending--;
          if (pending === 0) {
            settle();
          }
        });
    }
  });
}
