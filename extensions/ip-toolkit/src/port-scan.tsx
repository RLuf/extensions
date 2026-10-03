import { Action, ActionPanel, Color, Form, Icon, List, showToast, Toast, useNavigation } from "@raycast/api";
import { useEffect, useState } from "react";
import { COMMON_PORTS, parsePorts, PortResult, resolveHost, scanPorts } from "./lib/portscan";

type Preset = "common" | "well-known" | "custom";

interface FormValues {
  host: string;
  preset: Preset;
  ports?: string;
  timeout: string;
}

export default function Command() {
  const { push } = useNavigation();
  const [preset, setPreset] = useState<Preset>("common");
  const [hostError, setHostError] = useState<string>();
  const [portsError, setPortsError] = useState<string>();

  const onSubmit = (values: FormValues) => {
    const host = values.host.trim();
    if (!host || /\s/.test(host)) {
      setHostError("Type a host name or an IP address");
      return;
    }
    let ports: number[];
    if (values.preset === "common") {
      ports = COMMON_PORTS;
    } else if (values.preset === "well-known") {
      ports = Array.from({ length: 1024 }, (_, index) => index + 1);
    } else {
      const parsed = parsePorts(values.ports ?? "");
      if ("error" in parsed) {
        setPortsError(parsed.error);
        return;
      }
      ports = parsed.ports;
    }
    push(<ScanResults host={host} ports={ports} timeoutMs={Number(values.timeout)} />);
  };

  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Start Scan" icon={Icon.MagnifyingGlass} onSubmit={onSubmit} />
        </ActionPanel>
      }
    >
      <Form.Description text="Only scan hosts you own or are authorized to test. Scanning third-party systems may be illegal or break their terms of service." />
      <Form.TextField
        id="host"
        title="Host"
        placeholder="192.168.0.1 or example.com"
        defaultValue="127.0.0.1"
        error={hostError}
        onChange={() => setHostError(undefined)}
      />
      <Form.Dropdown id="preset" title="Ports" value={preset} onChange={(value) => setPreset(value as Preset)}>
        <Form.Dropdown.Item value="common" title={`Common Services (${COMMON_PORTS.length} ports)`} />
        <Form.Dropdown.Item value="well-known" title="Well-Known Ports (1-1024)" />
        <Form.Dropdown.Item value="custom" title="Custom List" />
      </Form.Dropdown>
      {preset === "custom" && (
        <Form.TextField
          id="ports"
          title="Port List"
          placeholder="22, 80, 443, 8000-8010"
          info="Up to 1024 ports. Separate with commas; use a dash for ranges."
          error={portsError}
          onChange={() => setPortsError(undefined)}
        />
      )}
      <Form.Dropdown id="timeout" title="Timeout per Port" defaultValue="800">
        <Form.Dropdown.Item value="300" title="300 ms (local network)" />
        <Form.Dropdown.Item value="800" title="800 ms" />
        <Form.Dropdown.Item value="2000" title="2 s (slow or distant hosts)" />
      </Form.Dropdown>
    </Form>
  );
}

const STATE_COLOR: Record<PortResult["state"], Color> = {
  open: Color.Green,
  closed: Color.SecondaryText,
  filtered: Color.Orange,
};

function ScanResults(props: { host: string; ports: number[]; timeoutMs: number }) {
  const { host, ports, timeoutMs } = props;
  const [address, setAddress] = useState<string>();
  const [results, setResults] = useState<PortResult[]>([]);
  const [done, setDone] = useState(0);
  const [finished, setFinished] = useState(false);
  const [filter, setFilter] = useState("open");

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const resolved = await resolveHost(host);
        setAddress(resolved);
        await scanPorts(resolved, ports, {
          timeoutMs,
          signal: controller.signal,
          onResult: (result, count) => {
            setDone(count);
            setResults((current) => [...current, result].sort((a, b) => a.port - b.port));
          },
        });
        if (!controller.signal.aborted) {
          setFinished(true);
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setFinished(true);
          await showToast({
            style: Toast.Style.Failure,
            title: `Could not resolve ${host}`,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();
    return () => controller.abort();
  }, []);

  const open = results.filter((result) => result.state === "open");
  const visible = filter === "open" ? open : results;
  const target = address && address !== host ? `${host} (${address})` : host;

  return (
    <List
      isLoading={!finished}
      navigationTitle={finished ? `${open.length} Open on ${host}` : `Scanning ${done}/${ports.length}`}
      searchBarPlaceholder="Filter by port or service"
      searchBarAccessory={
        <List.Dropdown tooltip="Show" value={filter} onChange={setFilter}>
          <List.Dropdown.Item title="Open Ports" value="open" />
          <List.Dropdown.Item title="All Results" value="all" />
        </List.Dropdown>
      }
    >
      <List.Section title={target} subtitle={`${open.length} open · ${done}/${ports.length} checked`}>
        {visible.map((result) => (
          <List.Item
            key={result.port}
            title={String(result.port)}
            subtitle={result.service}
            icon={{ source: Icon.Plug, tintColor: STATE_COLOR[result.state] }}
            keywords={[result.service ?? "", result.state]}
            accessories={[
              ...(result.latencyMs !== undefined ? [{ text: `${result.latencyMs} ms` }] : []),
              { tag: { value: result.state, color: STATE_COLOR[result.state] } },
            ]}
            actions={
              <ActionPanel>
                <Action.CopyToClipboard title="Copy Host and Port" content={`${address ?? host}:${result.port}`} />
                {result.state === "open" && (
                  <Action.OpenInBrowser
                    title="Open in Browser"
                    url={`${[443, 8443].includes(result.port) ? "https" : "http"}://${host}:${result.port}`}
                  />
                )}
                <Action.CopyToClipboard
                  title="Copy Open Ports"
                  content={open.map((entry) => `${entry.port}${entry.service ? ` ${entry.service}` : ""}`).join("\n")}
                />
              </ActionPanel>
            }
          />
        ))}
      </List.Section>
      {finished && visible.length === 0 && (
        <List.EmptyView
          icon={Icon.Lock}
          title="No Open Ports"
          description={`None of the ${ports.length} ports accepted a connection.`}
        />
      )}
    </List>
  );
}
