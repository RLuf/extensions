import { LaunchProps } from "@raycast/api";
import { WhoisView } from "./components/whois-view";

export default function Command(props: LaunchProps<{ arguments: Arguments.WhoisLookup }>) {
  return <WhoisView query={props.arguments.query} />;
}
