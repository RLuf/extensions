import {
  Action,
  ActionPanel,
  Alert,
  Clipboard,
  Color,
  confirmAlert,
  environment,
  Form,
  Icon,
  List,
  showToast,
  Toast,
  useNavigation,
} from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { useState } from "react";
import { getTunnelProcesses } from "./lib/windows-net";
import {
  findExecutable,
  getActiveTunnels,
  getNgrokAgentTunnels,
  startTunnel,
  stopTunnel,
  TUNNEL_TOOLS,
  TunnelTool,
} from "./lib/tunnel";

async function loadState() {
  const [cloudflared, ngrok, active, ngrokAgent, processes] = await Promise.all([
    findExecutable("cloudflared"),
    findExecutable("ngrok"),
    getActiveTunnels(),
    getNgrokAgentTunnels(),
    getTunnelProcesses(),
  ]);
  const ownPids = new Set(active.map((tunnel) => tunnel.pid));
  const ownUrls = new Set(active.map((tunnel) => tunnel.url));
  return {
    executables: { cloudflared, ngrok } as Record<TunnelTool, string | undefined>,
    active,
    ngrokAgent: ngrokAgent.filter((tunnel) => !ownUrls.has(tunnel.url)),
    // cloudflared/ngrok processes not started by this extension, e.g. a cloudflared Windows service.
    external: processes.filter((process) => !ownPids.has(process.pid)),
  };
}

export default function Command() {
  const { data, isLoading, revalidate } = usePromise(loadState, [], {
    failureToastOptions: { title: "Could not read tunnel status" },
  });

  const stop = async (pid: number, url: string) => {
    const confirmed = await confirmAlert({
      title: "Stop Tunnel?",
      message: `${url} will stop working immediately.`,
      primaryAction: { title: "Stop Tunnel", style: Alert.ActionStyle.Destructive },
    });
    if (!confirmed) {
      return;
    }
    const toast = await showToast({ style: Toast.Style.Animated, title: "Stopping tunnel" });
    try {
      await stopTunnel(pid);
      toast.style = Toast.Style.Success;
      toast.title = "Tunnel stopped";
    } catch (error) {
      toast.style = Toast.Style.Failure;
      toast.title = "Could not stop the tunnel";
      toast.message = error instanceof Error ? error.message : String(error);
    }
    revalidate();
  };

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Filter tunnels">
      <List.Section title="Active Tunnels">
        {data?.active.map((tunnel) => (
          <List.Item
            key={tunnel.pid}
            title={tunnel.url}
            subtitle={`localhost:${tunnel.port}`}
            icon={{ source: Icon.Globe, tintColor: Color.Green }}
            accessories={[
              { tag: { value: tunnel.tool, color: Color.Blue } },
              { date: new Date(tunnel.startedAt), tooltip: "Started" },
            ]}
            actions={
              <ActionPanel>
                <Action.CopyToClipboard title="Copy Public URL" content={tunnel.url} />
                <Action.OpenInBrowser url={tunnel.url} />
                <Action
                  title="Stop Tunnel"
                  icon={Icon.Stop}
                  style={Action.Style.Destructive}
                  onAction={() => stop(tunnel.pid, tunnel.url)}
                />
                <Action.Open title="Open Log File" target={tunnel.logFile} icon={Icon.Document} />
                <Action title="Refresh" icon={Icon.ArrowClockwise} onAction={revalidate} />
              </ActionPanel>
            }
          />
        ))}
        {data?.ngrokAgent.map((tunnel) => (
          <List.Item
            key={tunnel.url}
            title={tunnel.url}
            subtitle={tunnel.address}
            icon={{ source: Icon.Globe, tintColor: Color.Yellow }}
            accessories={[{ tag: "ngrok (started elsewhere)" }]}
            actions={
              <ActionPanel>
                <Action.CopyToClipboard title="Copy Public URL" content={tunnel.url} />
                <Action.OpenInBrowser url={tunnel.url} />
              </ActionPanel>
            }
          />
        ))}
        {data?.external.map((process) => (
          <List.Item
            key={process.pid}
            title={`${process.name} is running`}
            subtitle={`PID ${process.pid}`}
            icon={{ source: Icon.Plug, tintColor: Color.Yellow }}
            accessories={[{ tag: "Started outside IP Toolkit", tooltip: "For example a Windows service" }]}
            actions={
              <ActionPanel>
                <Action.CopyToClipboard title="Copy PID" content={String(process.pid)} />
              </ActionPanel>
            }
          />
        ))}
      </List.Section>
      <List.Section title="Start a Tunnel">
        {(Object.keys(TUNNEL_TOOLS) as TunnelTool[]).map((tool) => (
          <ToolItem key={tool} tool={tool} executable={data?.executables[tool]} onChange={revalidate} />
        ))}
      </List.Section>
    </List>
  );
}

function ToolItem(props: { tool: TunnelTool; executable?: string; onChange: () => void }) {
  const { tool, executable, onChange } = props;
  const info = TUNNEL_TOOLS[tool];
  const installCommand = `winget install --id ${info.wingetId} --exact`;

  if (!executable) {
    return (
      <List.Item
        title={`Install ${tool}`}
        subtitle={info.title}
        icon={{ source: Icon.Download, tintColor: Color.SecondaryText }}
        accessories={[{ tag: { value: "Not Installed", color: Color.Orange } }]}
        actions={
          <ActionPanel>
            <Action.OpenInBrowser title="Download Installer" url={info.directDownload} icon={Icon.Download} />
            <Action.OpenInBrowser title="Open Download Page" url={info.downloadPage} />
            <Action.CopyToClipboard title="Copy Winget Install Command" content={installCommand} />
            <Action title="Check Again" icon={Icon.ArrowClockwise} onAction={onChange} />
          </ActionPanel>
        }
      />
    );
  }

  return (
    <List.Item
      title={`Start ${info.title}`}
      subtitle={executable}
      icon={{ source: Icon.Rocket, tintColor: Color.Blue }}
      accessories={[{ tag: { value: "Installed", color: Color.Green } }]}
      actions={
        <ActionPanel>
          <Action.Push
            title={`Start ${info.title}`}
            icon={Icon.Rocket}
            target={<StartTunnelForm tool={tool} executable={executable} onStarted={onChange} />}
          />
          {info.setupPage && <Action.OpenInBrowser title="Get Ngrok Authtoken" url={info.setupPage} />}
          <Action.OpenInBrowser title="Open Download Page" url={info.downloadPage} />
        </ActionPanel>
      }
    />
  );
}

function StartTunnelForm(props: { tool: TunnelTool; executable: string; onStarted: () => void }) {
  const { tool, executable, onStarted } = props;
  const { pop } = useNavigation();
  const [portError, setPortError] = useState<string>();
  const info = TUNNEL_TOOLS[tool];

  const onSubmit = async (values: { port: string }) => {
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setPortError("Type a port between 1 and 65535");
      return;
    }
    const confirmed = await confirmAlert({
      title: `Expose localhost:${port} to the Internet?`,
      message: "Anyone who has the link can reach this port while the tunnel is running.",
      primaryAction: { title: "Start Tunnel", style: Alert.ActionStyle.Destructive },
    });
    if (!confirmed) {
      return;
    }
    const toast = await showToast({ style: Toast.Style.Animated, title: `Starting ${info.title}` });
    try {
      const tunnel = await startTunnel({ tool, executable, port, logDirectory: environment.supportPath });
      await Clipboard.copy(tunnel.url);
      toast.style = Toast.Style.Success;
      toast.title = "Tunnel ready, URL copied";
      toast.message = tunnel.url;
      onStarted();
      pop();
    } catch (error) {
      toast.style = Toast.Style.Failure;
      toast.title = "Could not start the tunnel";
      toast.message = error instanceof Error ? error.message : String(error);
    }
  };

  return (
    <Form
      navigationTitle={info.title}
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Start Tunnel" icon={Icon.Rocket} onSubmit={onSubmit} />
        </ActionPanel>
      }
    >
      <Form.Description
        text={
          tool === "cloudflared"
            ? "Creates a temporary trycloudflare.com address. No Cloudflare account needed; the URL changes every time."
            : "Uses your ngrok account. Run 'ngrok config add-authtoken <token>' once before the first tunnel."
        }
      />
      <Form.TextField
        id="port"
        title="Local Port"
        placeholder="3000"
        info="The HTTP service on this computer that the public URL will forward to"
        error={portError}
        onChange={() => setPortError(undefined)}
      />
    </Form>
  );
}
