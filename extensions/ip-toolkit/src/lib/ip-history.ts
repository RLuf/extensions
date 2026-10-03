import { LocalStorage } from "@raycast/api";

export interface HistoryEntry {
  ip: string;
  source: string;
  /** ISO timestamps. */
  firstSeen: string;
  lastSeen: string;
}

const STORAGE_KEY = "public-ip-history";
const MAX_ENTRIES = 100;

export async function readHistory(): Promise<HistoryEntry[]> {
  const raw = await LocalStorage.getItem<string>(STORAGE_KEY);
  if (!raw) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as HistoryEntry[]) : [];
  } catch {
    return [];
  }
}

export async function clearHistory(): Promise<void> {
  await LocalStorage.removeItem(STORAGE_KEY);
}

/**
 * Records an observation of the public IP. The newest entry comes first; a
 * repeated IP only refreshes `lastSeen`. `changed` is true when the IP differs
 * from the previous observation (never on the very first one).
 */
export async function recordIP(
  ip: string,
  source: string,
  now = new Date(),
): Promise<{ changed: boolean; previous?: HistoryEntry }> {
  const history = await readHistory();
  const latest = history[0];
  const stamp = now.toISOString();
  if (latest && latest.ip === ip) {
    latest.lastSeen = stamp;
    await LocalStorage.setItem(STORAGE_KEY, JSON.stringify(history));
    return { changed: false, previous: latest };
  }
  history.unshift({ ip, source, firstSeen: stamp, lastSeen: stamp });
  await LocalStorage.setItem(STORAGE_KEY, JSON.stringify(history.slice(0, MAX_ENTRIES)));
  return { changed: Boolean(latest), previous: latest };
}
