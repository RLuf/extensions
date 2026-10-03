import { environment, LaunchType, showHUD, updateCommandMetadata } from "@raycast/api";
import { recordIP } from "./lib/ip-history";
import { getPublicIP } from "./lib/public-ip";

/**
 * Runs in the background every few minutes (see "interval" in package.json).
 * Shows the public IP under the command name and notifies when it changes.
 */
export default async function Command() {
  const isBackground = environment.launchType === LaunchType.Background;
  const time = new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
  try {
    const { ip, source } = await getPublicIP("ipv4");
    const { changed, previous } = await recordIP(ip, source);
    await updateCommandMetadata({ subtitle: `${ip} · checked ${time}` });
    if (changed && previous) {
      await showHUD(`Public IP changed: ${previous.ip} → ${ip}`);
    } else if (!isBackground) {
      await showHUD(`Public IP: ${ip} (monitoring every 5 minutes)`);
    }
  } catch {
    await updateCommandMetadata({ subtitle: `Offline · last check ${time}` });
    if (!isBackground) {
      await showHUD("Could not check the public IP");
    }
  }
}
