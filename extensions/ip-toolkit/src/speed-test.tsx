import { Action, ActionPanel, Detail, Icon, Keyboard, showToast, Toast } from "@raycast/api";
import { useEffect, useState } from "react";
import {
  DOWNLOAD_BYTES,
  measureDownload,
  measureLatency,
  measureUpload,
  SpeedResult,
  UPLOAD_BYTES,
} from "./lib/speedtest";

type Phase = "latency" | "download" | "upload" | "done" | "failed";

const PHASE_LABEL: Record<Phase, string> = {
  latency: "Measuring latency…",
  download: `Downloading ${DOWNLOAD_BYTES / 1_000_000} MB…`,
  upload: `Uploading ${Math.round(UPLOAD_BYTES / 1_000_000)} MB…`,
  done: "Finished",
  failed: "Failed",
};

function show(value: number | undefined, unit: string, digits = 1): string {
  return value === undefined ? "…" : `${value.toFixed(digits)} ${unit}`;
}

function asText(result: SpeedResult): string {
  return [
    `Latency: ${show(result.latencyMs, "ms", 0)}`,
    `Download: ${show(result.downloadMbps, "Mbps")}`,
    `Upload: ${show(result.uploadMbps, "Mbps")}`,
  ].join("\n");
}

export default function Command() {
  const [runId, setRunId] = useState(0);
  const [phase, setPhase] = useState<Phase>("latency");
  const [result, setResult] = useState<SpeedResult>({});
  const [error, setError] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    setResult({});
    setError(undefined);

    (async () => {
      try {
        setPhase("latency");
        const latencyMs = await measureLatency(signal);
        setResult((current) => ({ ...current, latencyMs }));
        setPhase("download");
        const downloadMbps = await measureDownload(signal);
        setResult((current) => ({ ...current, downloadMbps }));
        setPhase("upload");
        const uploadMbps = await measureUpload(signal);
        setResult((current) => ({ ...current, uploadMbps }));
        setPhase("done");
      } catch (caught) {
        if (signal.aborted) {
          return;
        }
        const message = caught instanceof Error ? caught.message : String(caught);
        setError(message);
        setPhase("failed");
        await showToast({ style: Toast.Style.Failure, title: "Speed test failed", message });
      }
    })();

    return () => controller.abort();
  }, [runId]);

  const markdown = [
    "# Speed Test",
    "",
    "| Metric | Result |",
    "| --- | --- |",
    `| Latency | ${show(result.latencyMs, "ms", 0)} |`,
    `| Download | ${show(result.downloadMbps, "Mbps")} |`,
    `| Upload | ${show(result.uploadMbps, "Mbps")} |`,
    "",
    error ? `**Error:** ${error}` : `_${PHASE_LABEL[phase]}_`,
    "",
    "Measured against the nearest Cloudflare data center. One run of a single connection: a quick estimate, not a certified measurement.",
  ].join("\n");

  const running = phase !== "done" && phase !== "failed";

  return (
    <Detail
      isLoading={running}
      markdown={markdown}
      actions={
        <ActionPanel>
          {!running && (
            <Action
              title="Run Again"
              icon={Icon.ArrowClockwise}
              shortcut={Keyboard.Shortcut.Common.Refresh}
              onAction={() => setRunId((value) => value + 1)}
            />
          )}
          <Action.CopyToClipboard title="Copy Results" content={asText(result)} />
          <Action.OpenInBrowser title="Open Cloudflare Speed Test" url="https://speed.cloudflare.com" />
        </ActionPanel>
      }
    />
  );
}
