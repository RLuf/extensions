import { Action, ActionPanel, Color, Icon, List } from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { useState } from "react";
import { getLocalNetworkInfo } from "./lib/local-ip";
import { calculateSubnet, formatCount, SubnetInfo } from "./lib/subnet";

interface Row {
  title: string;
  value: string;
  icon: Icon;
}

function rowsFor(info: SubnetInfo): Row[] {
  const rows: Row[] = [
    { title: "Network", value: info.cidr, icon: Icon.Network },
    { title: "Netmask", value: info.netmask, icon: Icon.Filter },
  ];
  if (info.wildcard) {
    rows.push({ title: "Wildcard Mask", value: info.wildcard, icon: Icon.Filter });
  }
  if (info.broadcast) {
    rows.push({ title: "Broadcast", value: info.broadcast, icon: Icon.Megaphone });
  }
  rows.push(
    { title: info.family === 4 ? "First Host" : "First Address", value: info.firstHost, icon: Icon.ArrowRight },
    { title: info.family === 4 ? "Last Host" : "Last Address", value: info.lastHost, icon: Icon.ArrowLeft },
    { title: "Host Range", value: `${info.firstHost} - ${info.lastHost}`, icon: Icon.ArrowsExpand },
    {
      title: info.family === 4 ? "Usable Hosts" : "Addresses",
      value: formatCount(info.usableHosts),
      icon: Icon.Hashtag,
    },
    { title: "Total Addresses", value: formatCount(info.totalAddresses), icon: Icon.Hashtag },
    { title: "Address Type", value: info.addressType, icon: Icon.Tag },
  );
  return rows;
}

export default function Command() {
  const [searchText, setSearchText] = useState("");
  // With an empty search bar, start from the subnet of the interface that holds the default route.
  const local = usePromise(getLocalNetworkInfo);
  const fallback =
    local.data?.addresses.find((entry) => entry.isDefaultRoute && entry.family === "IPv4")?.cidr ??
    local.data?.addresses.find((entry) => entry.family === "IPv4" && entry.cidr)?.cidr;
  const input = searchText.trim() || fallback || "";
  const result = calculateSubnet(input);

  return (
    <List
      isLoading={local.isLoading}
      filtering={false}
      searchText={searchText}
      onSearchTextChange={setSearchText}
      searchBarPlaceholder="192.168.0.10/24, 10.0.0.1 255.255.0.0 or 2001:db8::/48"
    >
      {result.ok ? (
        <List.Section
          title={result.info.cidr}
          subtitle={searchText.trim() ? `IPv${result.info.family}` : `IPv${result.info.family} · your default network`}
        >
          {rowsFor(result.info).map((row) => (
            <List.Item
              key={row.title}
              title={row.value}
              subtitle={row.title}
              icon={{ source: row.icon, tintColor: Color.Blue }}
              actions={
                <ActionPanel>
                  <Action.CopyToClipboard title={`Copy ${row.title}`} content={row.value} />
                  <Action.Paste title="Paste at Cursor" content={row.value} />
                  <Action.CopyToClipboard
                    title="Copy All as Text"
                    content={rowsFor(result.info)
                      .map((entry) => `${entry.title}: ${entry.value}`)
                      .join("\n")}
                  />
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      ) : (
        <List.EmptyView icon={Icon.Calculator} title="Subnet Calculator" description={result.error} />
      )}
    </List>
  );
}
