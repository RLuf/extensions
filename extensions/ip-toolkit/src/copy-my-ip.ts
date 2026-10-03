import { Clipboard, LaunchProps, Toast, getPreferenceValues, showHUD, showToast } from "@raycast/api";
import { showFailureToast } from "@raycast/utils";
import { getMyIP, parseScope, type MyIP } from "./lib/my-ip";

export default async function Command(props: LaunchProps<{ arguments: Arguments.CopyMyIp }>) {
  const { ipVersion } = getPreferenceValues<Preferences.CopyMyIp>();
  const scope = parseScope(props.arguments.scope);

  const toast = await showToast({ style: Toast.Style.Animated, title: `Looking up your ${scope} IP…` });

  let result: MyIP;
  try {
    result = await getMyIP(scope, ipVersion);
  } catch (error) {
    await toast.hide();
    await showFailureToast(error, { title: `Could not get ${scope} IP` });
    return;
  }

  try {
    await Clipboard.copy(result.ip);
  } catch (error) {
    await toast.hide();
    await showFailureToast(error, { title: "Could not copy IP" });
    return;
  }
  await toast.hide();
  await showHUD(`Copied ${result.label} ${result.ip}`);
}
