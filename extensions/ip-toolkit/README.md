# IP Toolkit

See your external (public) IP (via [ip.me](https://ip.me) with fallback services) and internal (local) network addresses inside Raycast, then copy or paste them at the cursor in one step.

Works on **macOS** and **Windows**. No accounts, no API keys, no analytics.

![Show My IP](media/show-my-ip.png)

## Commands

| Command | Mode | What it does |
| --- | --- | --- |
| **Show My IP** | view | Lists your public IPv4 (and optionally IPv6) plus the address of every active network interface. Each row has copy and paste actions and an optional detail panel with CIDR, netmask, MAC and family. |
| **Copy My IP** | no-view | Copies your external or internal IP to the clipboard. Nothing opens; you only see a short confirmation. |
| **Paste My IP** | no-view | Pastes your external or internal IP at the cursor of the frontmost app (it also stays in the clipboard). |

### Show My IP

- **Public IP** section: the address the internet sees, with the service that answered.
- **Local Addresses** section: every non-loopback interface, IPv4 first. The address that currently reaches the internet is tagged **Default Route**.
- Local addresses appear instantly; the public IP row fills in as soon as a service answers.
- Actions: `Copy Public IPv4` / `Copy Address`, `Paste at Cursor`, `Copy CIDR`, `Copy MAC Address`, `Copy All as Text`, `Toggle Details`, `Refresh`, `Open in Browser`.
- Type in the search bar to filter by address, interface name, family (`ipv4`, `ipv6`) or `lan` / `wan`.

![Show My IP with details](media/show-my-ip-details.png)

![Show My IP actions](media/show-my-ip-actions.png)

### Copy My IP and Paste My IP

Both commands take an optional **External / Internal** argument (default: External). Type the command, press Tab to pick the scope, then Enter.

- **External**: the public address the internet sees, looked up through the services below.
- **Internal**: the local address of the interface holding the default route; if it cannot be detected, the first non-loopback (and, for IPv6, non-link-local) address.

No view opens. A short toast shows during the lookup, then a confirmation such as `Copied external IPv4 203.0.113.7` or `Pasted internal IPv4 192.168.0.10`. Paste My IP closes Raycast first so the address lands in the app that was in front; if pasting fails, the IP is still in the clipboard and the confirmation says so.

Assign hotkeys or aliases to these commands in Raycast settings for one-keystroke access.

## Preferences

| Command | Preference | Default | Description |
| --- | --- | --- | --- |
| Show My IP | Public IPv6 | off | Also look up the public IPv6 address. Keep it off on networks without IPv6 so the list opens faster. |
| Copy My IP | IP Version | IPv4 | Which address family to copy. |
| Paste My IP | IP Version | IPv4 | Which address family to paste. |

## How it works

- The public IP is requested from `ip.me` first. If it has not answered after 1.5 seconds the next service is started in parallel and the first valid answer wins: `ip4only.me`, `api.ipify.org`, `checkip.amazonaws.com` for IPv4; `ip.me`, `ip6only.me`, `api6.ipify.org`, `ipv6.icanhazip.com` for IPv6. Each service gets at most 4 seconds and the whole lookup never takes more than 10 seconds. Connections are pinned to the IP family being looked up, so an IPv4 lookup never travels over IPv6.
- Local addresses come from the operating system through Node's `os.networkInterfaces()`. Nothing leaves the machine for this part.
- The default-route address is estimated by connecting a UDP socket towards a public resolver and reading which local address the OS picked. No packet is sent; this may differ from the route chosen for a specific destination, VPN, or proxy.

### Privacy

Public-IP lookups send HTTPS requests to the services listed above, which see the requesting public IP and standard request metadata. A UDP socket is connected for route selection without sending a packet. The extension stores nothing and sends no analytics.

## Development

```bash
npm install
npm run dev      # loads the extension into Raycast and watches for changes
npm run build    # distribution build (does not run the TypeScript compiler)
npm run lint     # manifest, assets, ESLint + Prettier checks
npx tsc --noEmit -p tsconfig.json  # independent type check
```

## License

MIT
