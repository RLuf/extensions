# IP Toolkit Changelog

## [Initial Version] - {PR_MERGE_DATE}

- Add `Show My IP` command: a list with the public IPv4 (optionally IPv6) and every local interface address, with copy, paste, CIDR, MAC and detail panel actions
- Add `Copy My IP` command: copies the external or internal IP (IPv4 or IPv6) to the clipboard without opening a view
- Add `Paste My IP` command: pastes the external or internal IP at the cursor of the frontmost app
- Resolve the public IP through ip.me with hedged fallback to ip4only.me, ipify and checkip.amazonaws.com (IPv6: ip.me, ip6only.me, api6.ipify.org, ipv6.icanhazip.com), family-pinned connections and a 10 second overall budget
- Detect which local address holds the default route and tag it in the list
- Support macOS and Windows
