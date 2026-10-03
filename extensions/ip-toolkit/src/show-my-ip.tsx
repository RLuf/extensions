import { Action, ActionPanel, Color, Icon, Keyboard, List, getPreferenceValues } from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { ReactNode, useRef, useState } from "react";
import { getLocalNetworkInfo, LocalAddress, LocalNetworkInfo } from "./lib/local-ip";
import { getPublicIP, IPVersion, PublicIPResult } from "./lib/public-ip";

type PublicIPState = { status: "ok"; result: PublicIPResult } | { status: "unavailable"; reason: string };

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

async function resolvePublicIP(version: IPVersion, signal?: AbortSignal): Promise<PublicIPState> {
  try {
    return { status: "ok", result: await getPublicIP(version, signal) };
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

function snapshotAsText(publicIPs: PublicIPs | undefined, local: LocalNetworkInfo | undefined): string {
  const lines: string[] = [];
  if (publicIPs) {
    lines.push(`Public IPv4: ${describePublicIP(publicIPs.ipv4)}`);
    if (publicIPs.ipv6) {
      lines.push(`Public IPv6: ${describePublicIP(publicIPs.ipv6)}`);
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

  // Local interfaces are instant; the public lookup talks to the internet.
  // Two independent promises so the local rows never wait for the network.
  const local = usePromise(getLocalNetworkInfo, [], {
    failureToastOptions: { title: "Could not read network interfaces" },
  });
  const publicIPs = usePromise(
    async (withIPv6: boolean) => loadPublicIPs(withIPv6, abortable.current?.signal),
    [showIPv6],
    { abortable, failureToastOptions: { title: "Could not look up the public IP" } },
  );

  const isLoading = local.isLoading || publicIPs.isLoading;
  const refresh = () => {
    local.revalidate();
    publicIPs.revalidate();
  };
  const hasRows = Boolean(publicIPs.data) || (local.data?.addresses.length ?? 0) > 0;

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
          content={snapshotAsText(publicIPs.data, local.data)}
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
          <PublicIPItem version="IPv4" state={publicIPs.data.ipv4} isShowingDetail={isShowingDetail}>
            {sharedActions}
          </PublicIPItem>
          {publicIPs.data.ipv6 && (
            <PublicIPItem version="IPv6" state={publicIPs.data.ipv6} isShowingDetail={isShowingDetail}>
              {sharedActions}
            </PublicIPItem>
          )}
        </List.Section>
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
  isShowingDetail: boolean;
  children: ReactNode;
}) {
  const { version, state, isShowingDetail, children } = props;
  const ip = state.status === "ok" ? state.result.ip : undefined;
  const source = state.status === "ok" ? state.result.source : undefined;
  const subtitle = state.status === "ok" ? `via ${state.result.source}` : state.reason;
  const tint = ip ? Color.Green : Color.SecondaryText;

  return (
    <List.Item
      title={ip ?? "Unavailable"}
      subtitle={isShowingDetail ? undefined : subtitle}
      icon={{ source: Icon.Globe, tintColor: tint }}
      keywords={["public", "wan", "external", version.toLowerCase()]}
      accessories={
        isShowingDetail ? undefined : [{ tag: { value: version, color: ip ? Color.Blue : Color.SecondaryText } }]
      }
      detail={
        <List.Item.Detail
          metadata={
            <List.Item.Detail.Metadata>
              <List.Item.Detail.Metadata.Label title="Type" text={`Public ${version}`} icon={Icon.Globe} />
              <List.Item.Detail.Metadata.Label title="Address" text={ip ?? "Unavailable"} />
              {source ? (
                <List.Item.Detail.Metadata.Link title="Source" text={source} target={`https://${source}`} />
              ) : (
                <List.Item.Detail.Metadata.Label title="Reason" text={subtitle} />
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
            </ActionPanel.Section>
          )}
          <ActionPanel.Section>{children}</ActionPanel.Section>
        </ActionPanel>
      }
    />
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
