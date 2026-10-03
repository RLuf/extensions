import { Action, ActionPanel, Color, Icon, Keyboard, List, getPreferenceValues } from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { ReactNode, useRef, useState } from "react";
import { WhoisView } from "./components/whois-view";
import { getLocalNetworkInfo, LocalAddress, LocalNetworkInfo } from "./lib/local-ip";
import { Agreement, getPublicIPConsensus, IPVersion, PublicIPConsensus } from "./lib/public-ip";
import { getNetworkDetails, NetworkDetails } from "./lib/windows-net";

type PublicIPState = { status: "ok"; result: PublicIPConsensus } | { status: "unavailable"; reason: string };

interface PublicIPs {
  ipv4: PublicIPState;
  ipv6?: PublicIPState;
}

const COPY_CIDR_SHORTCUT: Keyboard.Shortcut = {
  macOS: { modifiers: ["cmd"], key: "d" },
  Windows: { modifiers: ["ctrl"], key: "d" },
};
const COPY_MAC_SHORTCUT: Keyboard.Shortcut = {
  macOS: { modifiers: ["cmd"], key: "m" },
  Windows: { modifiers: ["ctrl"], key: "m" },
};

const AGREEMENT_TAG: Record<Agreement, { value: string; color: Color; tooltip: string }> = {
  confirmed: { value: "✓ Confirmed", color: Color.Green, tooltip: "Two independent services returned this address" },
  mismatch: {
    value: "⚠ Mismatch",
    color: Color.Orange,
    tooltip: "Services disagree: multiple WAN links, load-balanced NAT or a proxy in the path",
  },
  single: { value: "Single Source", color: Color.SecondaryText, tooltip: "Only one service answered" },
};

async function resolvePublicIP(version: IPVersion, signal?: AbortSignal): Promise<PublicIPState> {
  try {
    return { status: "ok", result: await getPublicIPConsensus(version, signal) };
  } catch (error) {
    return { status: "unavailable", reason: error instanceof Error ? error.message : String(error) };
  }
}

async function loadPublicIPs(showIPv6: boolean, signal?: AbortSignal): Promise<PublicIPs> {
  const [ipv4, ipv6] = await Promise.all([
    resolvePublicIP("ipv4", signal),
    showIPv6 ? resolvePublicIP("ipv6", signal) : Promise.resolve(undefined),
  ]);
  return { ipv4, ipv6 };
}

function describePublicIP(state: PublicIPState | undefined): string {
  return state?.status === "ok" ? state.result.ip : "unavailable";
}

function snapshotAsText(
  publicIPs: PublicIPs | undefined,
  local: LocalNetworkInfo | undefined,
  network: NetworkDetails | undefined,
): string {
  const lines: string[] = [];
  if (publicIPs) {
    lines.push(`Public IPv4: ${describePublicIP(publicIPs.ipv4)}`);
    if (publicIPs.ipv6) {
      lines.push(`Public IPv6: ${describePublicIP(publicIPs.ipv6)}`);
    }
  }
  if (network) {
    for (const gateway of network.gateways) {
      lines.push(`Gateway ${gateway.family}: ${gateway.gateway} (${gateway.interfaceAlias})`);
    }
    for (const entry of network.dns) {
      lines.push(`DNS ${entry.family}: ${entry.servers.join(", ")} (${entry.interfaceAlias})`);
    }
    for (const wifi of network.wifi) {
      lines.push(`Wi-Fi: ${wifi.ssid}${wifi.signal !== undefined ? ` (${wifi.signal}%)` : ""}`);
    }
  }
  if (local) {
    lines.push("", `Host: ${local.hostname}`);
    for (const entry of local.addresses) {
      const route = entry.isDefaultRoute ? ", default route" : "";
      lines.push(`${entry.interfaceName}: ${entry.cidr ?? entry.address} (${entry.family}${route})`);
    }
  }
  return lines.join("\n");
}

export default function Command() {
  const { showIPv6 } = getPreferenceValues<Preferences.ShowMyIp>();
  const [isShowingDetail, setIsShowingDetail] = useState(false);
  const abortable = useRef<AbortController>(null);

  // Three independent promises: local interfaces are instant, the Windows network
  // details take about a second and the public lookup talks to the internet.
  const local = usePromise(getLocalNetworkInfo, [], {
    failureToastOptions: { title: "Could not read network interfaces" },
  });
  const network = usePromise(getNetworkDetails, [], {
    failureToastOptions: { title: "Could not read gateway and DNS settings" },
  });
  const publicIPs = usePromise(
    async (withIPv6: boolean) => loadPublicIPs(withIPv6, abortable.current?.signal),
    [showIPv6],
    { abortable, failureToastOptions: { title: "Could not look up the public IP" } },
  );

  const isLoading = local.isLoading || publicIPs.isLoading || network.isLoading;
  const refresh = () => {
    local.revalidate();
    network.revalidate();
    publicIPs.revalidate();
  };
  const hasRows = Boolean(publicIPs.data) || (local.data?.addresses.length ?? 0) > 0;
  const vpnAdapters = network.data?.vpnAdapters ?? [];

  const sharedActions = (
    <>
      {hasRows && (
        <Action
          title="Toggle Details"
          icon={Icon.AppWindowSidebarRight}
          shortcut={Keyboard.Shortcut.Common.ToggleQuickLook}
          onAction={() => setIsShowingDetail((value) => !value)}
        />
      )}
      <Action
        title="Refresh"
        icon={Icon.ArrowClockwise}
        shortcut={Keyboard.Shortcut.Common.Refresh}
        onAction={refresh}
      />
      {hasRows && (
        <Action.CopyToClipboard
          title="Copy All as Text"
          icon={Icon.Clipboard}
          content={snapshotAsText(publicIPs.data, local.data, network.data)}
          shortcut={Keyboard.Shortcut.Common.Copy}
        />
      )}
      <Action.OpenInBrowser title="Open in Browser" url="https://ip.me" icon={Icon.Globe} />
    </>
  );

  return (
    <List
      isLoading={isLoading}
      isShowingDetail={isShowingDetail && hasRows}
      searchBarPlaceholder="Filter addresses and interfaces"
    >
      {publicIPs.data && (
        <List.Section title="Public IP" subtitle="How the internet sees you">
          <PublicIPItem
            version="IPv4"
            state={publicIPs.data.ipv4}
            vpnAdapters={vpnAdapters}
            isShowingDetail={isShowingDetail}
          >
            {sharedActions}
          </PublicIPItem>
          {publicIPs.data.ipv6 && (
            <PublicIPItem
              version="IPv6"
              state={publicIPs.data.ipv6}
              vpnAdapters={vpnAdapters}
              isShowingDetail={isShowingDetail}
            >
              {sharedActions}
            </PublicIPItem>
          )}
        </List.Section>
      )}
      {network.data && (
        <NetworkSection details={network.data} isShowingDetail={isShowingDetail} actions={sharedActions} />
      )}
      {local.data && local.data.addresses.length > 0 && (
        <List.Section title="Local Addresses" subtitle={local.data.hostname}>
          {local.data.addresses.map((entry, index) => (
            <LocalAddressItem
              key={`${index}-${entry.interfaceName}-${entry.address}`}
              entry={entry}
              isShowingDetail={isShowingDetail}
            >
              {sharedActions}
            </LocalAddressItem>
          ))}
        </List.Section>
      )}
      {!isLoading && !hasRows && (
        <List.EmptyView
          icon={Icon.Network}
          title="No Network Information"
          description="Could not read the public IP or the local interfaces."
          actions={<ActionPanel>{sharedActions}</ActionPanel>}
        />
      )}
    </List>
  );
}

function PublicIPItem(props: {
  version: "IPv4" | "IPv6";
  state: PublicIPState;
  vpnAdapters: string[];
  isShowingDetail: boolean;
  children: ReactNode;
}) {
  const { version, state, vpnAdapters, isShowingDetail, children } = props;
  const result = state.status === "ok" ? state.result : undefined;
  const ip = result?.ip;
  const subtitle = result
    ? `via ${result.confirmedBy.join(" + ")}`
    : state.status === "unavailable"
      ? state.reason
      : "";
  const agreement = result ? AGREEMENT_TAG[result.agreement] : undefined;

  const accessories: List.Item.Accessory[] = [];
  if (!isShowingDetail) {
    if (vpnAdapters.length > 0) {
      accessories.push({
        tag: { value: "VPN?", color: Color.Purple },
        tooltip: `Default route goes through ${vpnAdapters.join(", ")}`,
      });
    }
    if (agreement) {
      accessories.push({ tag: { value: agreement.value, color: agreement.color }, tooltip: agreement.tooltip });
    }
    accessories.push({ tag: { value: version, color: ip ? Color.Blue : Color.SecondaryText } });
  }

  return (
    <List.Item
      title={ip ?? "Unavailable"}
      subtitle={isShowingDetail ? undefined : subtitle}
      icon={{ source: Icon.Globe, tintColor: ip ? Color.Green : Color.SecondaryText }}
      keywords={["public", "wan", "external", version.toLowerCase()]}
      accessories={accessories}
      detail={
        <List.Item.Detail
          metadata={
            <List.Item.Detail.Metadata>
              <List.Item.Detail.Metadata.Label title="Type" text={`Public ${version}`} icon={Icon.Globe} />
              <List.Item.Detail.Metadata.Label title="Address" text={ip ?? "Unavailable"} />
              {agreement && (
                <List.Item.Detail.Metadata.TagList title="Cross-Check">
                  <List.Item.Detail.Metadata.TagList.Item text={agreement.value} color={agreement.color} />
                </List.Item.Detail.Metadata.TagList>
              )}
              {result ? (
                result.answers.map((answer) => (
                  <List.Item.Detail.Metadata.Link
                    key={answer.source}
                    title={answer.ip === result.ip ? "Source" : "Different Answer"}
                    text={`${answer.source}: ${answer.ip}`}
                    target={`https://${answer.source}`}
                  />
                ))
              ) : (
                <List.Item.Detail.Metadata.Label title="Reason" text={subtitle} />
              )}
              {vpnAdapters.length > 0 && (
                <List.Item.Detail.Metadata.Label title="VPN Adapter" text={vpnAdapters.join(", ")} />
              )}
            </List.Item.Detail.Metadata>
          }
        />
      }
      actions={
        <ActionPanel>
          {ip && (
            <ActionPanel.Section>
              <Action.CopyToClipboard title={`Copy Public ${version}`} content={ip} />
              <Action.Paste title="Paste at Cursor" content={ip} />
              <Action.Push title="Whois Lookup" icon={Icon.MagnifyingGlass} target={<WhoisView query={ip} />} />
            </ActionPanel.Section>
          )}
          <ActionPanel.Section>{children}</ActionPanel.Section>
        </ActionPanel>
      }
    />
  );
}

function InfoItem(props: {
  title: string;
  subtitle: string;
  icon: Icon;
  tint?: Color;
  copy: string;
  accessories?: List.Item.Accessory[];
  isShowingDetail: boolean;
  actions: ReactNode;
}) {
  const { title, subtitle, icon, tint, copy, accessories, isShowingDetail, actions } = props;
  return (
    <List.Item
      title={title}
      subtitle={isShowingDetail ? undefined : subtitle}
      icon={{ source: icon, tintColor: tint ?? Color.Blue }}
      keywords={[subtitle]}
      accessories={isShowingDetail ? undefined : accessories}
      detail={
        <List.Item.Detail
          metadata={
            <List.Item.Detail.Metadata>
              <List.Item.Detail.Metadata.Label title={subtitle} text={title} icon={icon} />
            </List.Item.Detail.Metadata>
          }
        />
      }
      actions={
        <ActionPanel>
          <ActionPanel.Section>
            <Action.CopyToClipboard title="Copy" content={copy} />
            <Action.Paste title="Paste at Cursor" content={copy} />
          </ActionPanel.Section>
          <ActionPanel.Section>{actions}</ActionPanel.Section>
        </ActionPanel>
      }
    />
  );
}

function NetworkSection(props: { details: NetworkDetails; isShowingDetail: boolean; actions: ReactNode }) {
  const { details, isShowingDetail, actions } = props;
  const hasContent = details.gateways.length + details.dns.length + details.wifi.length + details.tunnels.length > 0;
  if (!hasContent) {
    return null;
  }
  return (
    <List.Section title="Network" subtitle="Gateway, DNS and connections">
      {details.gateways.map((gateway) => (
        <InfoItem
          key={`gw-${gateway.interfaceIndex}-${gateway.gateway}`}
          title={gateway.gateway}
          subtitle={`Default Gateway · ${gateway.interfaceAlias}`}
          icon={Icon.Switch}
          copy={gateway.gateway}
          accessories={[{ tag: gateway.family }]}
          isShowingDetail={isShowingDetail}
          actions={actions}
        />
      ))}
      {details.dns.map((entry) => (
        <InfoItem
          key={`dns-${entry.interfaceIndex}-${entry.family}`}
          title={entry.servers.join(", ")}
          subtitle={`DNS Servers · ${entry.interfaceAlias}`}
          icon={Icon.List}
          copy={entry.servers.join(", ")}
          accessories={[{ tag: entry.family }]}
          isShowingDetail={isShowingDetail}
          actions={actions}
        />
      ))}
      {details.wifi.map((wifi) => (
        <InfoItem
          key={`wifi-${wifi.interfaceName}`}
          title={wifi.ssid}
          subtitle={`Wi-Fi · ${wifi.interfaceName}`}
          icon={Icon.Wifi}
          copy={wifi.ssid}
          accessories={wifi.signal !== undefined ? [{ text: `${wifi.signal}%`, tooltip: "Signal quality" }] : []}
          isShowingDetail={isShowingDetail}
          actions={actions}
        />
      ))}
      {details.tunnels.map((tunnel) => (
        <InfoItem
          key={`tunnel-${tunnel.pid}`}
          title={`${tunnel.name} is running`}
          subtitle={`Tunnel · PID ${tunnel.pid}`}
          icon={Icon.Plug}
          tint={Color.Yellow}
          copy={String(tunnel.pid)}
          accessories={[{ tag: { value: "Tunnel Active", color: Color.Yellow } }]}
          isShowingDetail={isShowingDetail}
          actions={actions}
        />
      ))}
    </List.Section>
  );
}

function LocalAddressItem(props: { entry: LocalAddress; isShowingDetail: boolean; children: ReactNode }) {
  const { entry, isShowingDetail, children } = props;
  const accessories: List.Item.Accessory[] = [];
  if (!isShowingDetail) {
    if (entry.isDefaultRoute) {
      accessories.push({ tag: { value: "Default Route", color: Color.Green }, tooltip: "Used to reach the internet" });
    }
    accessories.push({ tag: entry.family });
  }

  return (
    <List.Item
      title={entry.address}
      subtitle={isShowingDetail ? undefined : entry.interfaceName}
      icon={{ source: Icon.Network, tintColor: entry.isDefaultRoute ? Color.Green : Color.SecondaryText }}
      keywords={[entry.interfaceName, entry.family.toLowerCase(), "local", "lan", "private"]}
      accessories={accessories}
      detail={
        <List.Item.Detail
          metadata={
            <List.Item.Detail.Metadata>
              <List.Item.Detail.Metadata.Label title="Interface" text={entry.interfaceName} icon={Icon.Network} />
              <List.Item.Detail.Metadata.Label title="Address" text={entry.address} />
              {entry.cidr && <List.Item.Detail.Metadata.Label title="CIDR" text={entry.cidr} />}
              <List.Item.Detail.Metadata.Label title="Netmask" text={entry.netmask} />
              <List.Item.Detail.Metadata.Label title="MAC" text={entry.mac} />
              <List.Item.Detail.Metadata.Separator />
              <List.Item.Detail.Metadata.TagList title="Family">
                <List.Item.Detail.Metadata.TagList.Item text={entry.family} color={Color.Blue} />
                {entry.isDefaultRoute && (
                  <List.Item.Detail.Metadata.TagList.Item text="Default Route" color={Color.Green} />
                )}
              </List.Item.Detail.Metadata.TagList>
              {entry.scopeId !== undefined && (
                <List.Item.Detail.Metadata.Label title="Scope ID" text={String(entry.scopeId)} />
              )}
            </List.Item.Detail.Metadata>
          }
        />
      }
      actions={
        <ActionPanel>
          <ActionPanel.Section>
            <Action.CopyToClipboard title="Copy Address" content={entry.address} />
            <Action.Paste title="Paste at Cursor" content={entry.address} />
            {entry.cidr && (
              <Action.CopyToClipboard title="Copy CIDR" content={entry.cidr} shortcut={COPY_CIDR_SHORTCUT} />
            )}
            <Action.CopyToClipboard title="Copy MAC Address" content={entry.mac} shortcut={COPY_MAC_SHORTCUT} />
          </ActionPanel.Section>
          <ActionPanel.Section>{children}</ActionPanel.Section>
        </ActionPanel>
      }
    />
  );
}
