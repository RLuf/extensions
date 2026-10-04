import { Action, ActionPanel, Color, Detail, Icon } from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { useRef } from "react";
import { getPublicIP } from "../lib/public-ip";
import { RdapSummary, rdapLookup } from "../lib/whois";

const KIND_LABEL: Record<RdapSummary["kind"], string> = { ip: "IP Network", domain: "Domain", autnum: "AS Number" };

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString("en-US", { dateStyle: "medium" });
}

function toMarkdown(summary: RdapSummary): string {
  const lines = [
    `# ${summary.query}`,
    "",
    `**${KIND_LABEL[summary.kind]}**${summary.name ? ` · ${summary.name}` : ""}`,
  ];
  if (summary.registrant) {
    lines.push("", `Registered to **${summary.registrant}**${summary.country ? ` (${summary.country})` : ""}.`);
  }
  if (summary.range || summary.cidrs.length > 0) {
    lines.push("", "## Address Block", "");
    if (summary.range) {
      lines.push(`- Range: \`${summary.range}\``);
    }
    summary.cidrs.forEach((cidr) => lines.push(`- CIDR: \`${cidr}\``));
  }
  if (summary.nameservers.length > 0) {
    lines.push("", "## Name Servers", "", ...summary.nameservers.map((server) => `- \`${server}\``));
  }
  if (summary.abuseEmails.length > 0) {
    lines.push("", "## Abuse Contact", "", ...summary.abuseEmails.map((email) => `- ${email}`));
  }
  if (summary.remarks.length > 0) {
    lines.push("", "## Remarks", "", ...summary.remarks.slice(0, 12).map((line) => `> ${line}`));
  }
  return lines.join("\n");
}

export function WhoisView(props: { query?: string }) {
  const abortable = useRef<AbortController>(null);
  const { data, isLoading, error, revalidate } = usePromise(
    async (query: string | undefined) => {
      const signal = abortable.current?.signal;
      const target = query?.trim() || (await getPublicIP("ipv4", signal)).ip;
      return rdapLookup(target, signal);
    },
    [props.query],
    { abortable, failureToastOptions: { title: "Whois lookup failed" } },
  );

  const markdown = data
    ? toMarkdown(data)
    : error
      ? `# Lookup Failed\n\n${error.message}`
      : `# Looking Up ${props.query?.trim() || "Your Public IP"}…`;

  return (
    <Detail
      isLoading={isLoading}
      navigationTitle={data ? `Whois · ${data.query}` : "Whois Lookup"}
      markdown={markdown}
      metadata={
        data && (
          <Detail.Metadata>
            {data.handle && <Detail.Metadata.Label title="Handle" text={data.handle} />}
            {data.name && <Detail.Metadata.Label title="Name" text={data.name} />}
            {data.type && <Detail.Metadata.Label title="Type" text={data.type} />}
            {data.country && <Detail.Metadata.Label title="Country" text={data.country} />}
            {data.registrant && <Detail.Metadata.Label title="Registrant" text={data.registrant} />}
            {data.registrar && <Detail.Metadata.Label title="Registrar" text={data.registrar} />}
            {data.status.length > 0 && (
              <Detail.Metadata.TagList title="Status">
                {data.status.map((status) => (
                  <Detail.Metadata.TagList.Item key={status} text={status} color={Color.Blue} />
                ))}
              </Detail.Metadata.TagList>
            )}
            {data.events.length > 0 && <Detail.Metadata.Separator />}
            {data.events.map((event) => (
              <Detail.Metadata.Label
                key={`${event.action}-${event.date}`}
                title={event.action.replace(/\b\w/g, (letter) => letter.toUpperCase())}
                text={formatDate(event.date)}
              />
            ))}
            <Detail.Metadata.Separator />
            <Detail.Metadata.Link title="Source" text="RDAP" target={data.url} />
          </Detail.Metadata>
        )
      }
      actions={
        <ActionPanel>
          {data && (
            <>
              <Action.CopyToClipboard
                title="Copy as JSON"
                icon={Icon.Code}
                content={JSON.stringify(data.raw, null, 2)}
              />
              {data.abuseEmails[0] && (
                <Action.CopyToClipboard title="Copy Abuse Email" icon={Icon.Envelope} content={data.abuseEmails[0]} />
              )}
              <Action.OpenInBrowser title="Open RDAP Record" url={data.url} />
            </>
          )}
          <Action title="Refresh" icon={Icon.ArrowClockwise} onAction={revalidate} />
        </ActionPanel>
      }
    />
  );
}
