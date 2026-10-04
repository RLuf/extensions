import { Action, ActionPanel, Alert, Color, confirmAlert, Icon, List, showToast, Toast } from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { WhoisView } from "./components/whois-view";
import { clearHistory, readHistory, recordIP } from "./lib/ip-history";
import { getPublicIP } from "./lib/public-ip";

function duration(fromIso: string, toIso: string): string {
  const minutes = Math.max(0, Math.round((new Date(toIso).getTime() - new Date(fromIso).getTime()) / 60_000));
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} days`;
}

export default function Command() {
  const { data, isLoading, revalidate } = usePromise(readHistory);

  const checkNow = async () => {
    const toast = await showToast({ style: Toast.Style.Animated, title: "Checking public IP" });
    try {
      const { ip, source } = await getPublicIP("ipv4");
      const { changed, previous } = await recordIP(ip, source);
      toast.style = Toast.Style.Success;
      toast.title = changed && previous ? `Changed: ${previous.ip} → ${ip}` : `Public IP: ${ip}`;
      revalidate();
    } catch (error) {
      toast.style = Toast.Style.Failure;
      toast.title = "Could not check the public IP";
      toast.message = error instanceof Error ? error.message : String(error);
    }
  };

  const clear = async () => {
    const confirmed = await confirmAlert({
      title: "Clear IP History?",
      message: "Every recorded public IP will be deleted.",
      primaryAction: { title: "Clear History", style: Alert.ActionStyle.Destructive },
    });
    if (confirmed) {
      await clearHistory();
      revalidate();
    }
  };

  const commonActions = (
    <>
      <Action title="Check Now" icon={Icon.ArrowClockwise} onAction={checkNow} />
      {(data?.length ?? 0) > 0 && (
        <Action title="Clear History" icon={Icon.Trash} style={Action.Style.Destructive} onAction={clear} />
      )}
    </>
  );

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Filter IP history">
      {data?.map((entry, index) => (
        <List.Item
          key={`${entry.ip}-${entry.firstSeen}`}
          title={entry.ip}
          subtitle={`for ${duration(entry.firstSeen, entry.lastSeen)}`}
          icon={{ source: Icon.Globe, tintColor: index === 0 ? Color.Green : Color.SecondaryText }}
          accessories={[
            ...(index === 0 ? [{ tag: { value: "Current", color: Color.Green } }] : []),
            { date: new Date(entry.firstSeen), tooltip: `First seen ${new Date(entry.firstSeen).toLocaleString()}` },
          ]}
          actions={
            <ActionPanel>
              <Action.CopyToClipboard title="Copy IP" content={entry.ip} />
              <Action.Push title="Whois Lookup" icon={Icon.MagnifyingGlass} target={<WhoisView query={entry.ip} />} />
              {commonActions}
            </ActionPanel>
          }
        />
      ))}
      {!isLoading && (data?.length ?? 0) === 0 && (
        <List.EmptyView
          icon={Icon.Clock}
          title="No History Yet"
          description="Run Monitor Public IP once to start recording, or check now."
          actions={<ActionPanel>{commonActions}</ActionPanel>}
        />
      )}
    </List>
  );
}
