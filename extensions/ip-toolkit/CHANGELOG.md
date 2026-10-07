# IP Toolkit Changelog

## [Initial Version] - {PR_MERGE_DATE}

- Add `Show My IP` command: public IPv4 (optionally IPv6) cross-checked by two services, default gateway, DNS servers, Wi-Fi network, running tunnels, a VPN hint and every local interface address, with copy, paste and Whois actions
- Add `Copy My IP` command: copies the external or internal IP (IPv4 or IPv6) to the clipboard without opening a view
- Add `Paste My IP` command: pastes the external or internal IP at the cursor of the frontmost app
- Add `Monitor Public IP` background command: checks the public IP every 5 minutes, shows it under the command name and notifies when it changes
- Add `Public IP History` command: lists every public IP seen by the monitor
- Add `Whois Lookup` command: RDAP lookup for IP addresses, domains and AS numbers
- Add `Subnet Calculator` command: network, broadcast, host range and host count for IPv4 and IPv6
- Add `Port Scan` command: TCP connect scan of up to 1024 ports
- Add `Speed Test` command: latency, jitter, download and upload (Mbps and MB/s) through Cloudflare's speed test servers
- Add `Manage Tunnels` command: lists cloudflared and ngrok tunnels and exposes a local port through trycloudflare.com or ngrok
