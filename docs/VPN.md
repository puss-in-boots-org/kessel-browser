# Kessel's VPN

## What's built (net.rs)

Kessel has its own network layer. When any of these is set up, the engine starts with Kessel's own proxy on 127.0.0.1 as its proxy:

- secure DNS;
- a site that goes through a proxy of its own;
- a VPN server.

The layer then decides, for every connection, where it goes. Changing that never needs a restart. Only switching the layer itself on or off does.

```
 page ──► engine ──► Kessel's layer (127.0.0.1) ──┬─► site directly (DNS over HTTPS/TLS)
                                                   ├─► the site's own proxy
                                                   └─► the VPN server (SOCKS5 / HTTP)
```

How the VPN behaves:

- **One button.** The VPN pill in the address bar turns it on or off at once. Right-click it to pick the server. Open connections are closed when you switch, so nothing stays on the old route.
- **No DNS leaks.** The site's name goes to the VPN server, which looks it up. Kessel never resolves it locally.
- **Kill switch.** If the server can't be reached, pages fail. They never go around the VPN.
- **Local stays local.** Addresses on your own network (localhost, 192.168.x, 10.x, .local, printers) go directly.
- **WebRTC stays inside.** Calls go through the layer, not straight out, so they can't reveal your real address.
- **Only the browser is affected.** Other programs on the PC don't go through the VPN, which is what Opera's VPN does too.

The servers can be:

- **WireGuard** (`wg.rs`). Kessel runs WireGuard itself, with no app, driver or admin rights:
  - `boringtun` (Cloudflare's WireGuard) carries the tunnel over UDP;
  - `smoltcp` provides a small TCP/IP stack for the connections inside it;
  - names are looked up through the tunnel, at the VPN's own DNS.

  Two ways to add servers:
  - **Import config files** from any provider: Proton VPN, including its free plan, Mullvad, Surfshark, and so on.
  - **Surfshark:** paste your account's WireGuard private key once (my.surfshark.com → VPN → Manual setup → WireGuard → generate a key pair). Every location in Surfshark's public server list (142 locations in 100 countries) then becomes a server, chosen from the VPN button or Settings → Network.

  Private keys are kept encrypted for your Windows account (`vpn-keys.dat`, DPAPI) and never in `settings.json`.
- **SOCKS5 or HTTP proxies:** a VPN service's own, or a server of yours.

## Options for a free network built in (A is built)

Opera's VPN is free because Opera runs the servers. Kessel has no servers, so a built-in free network has to be someone else's. Each of these plugs into the same layer as one more kind of upstream, so the button, kill switch and DNS handling stay the same:

| | Speed | Cost / account | Countries | Privacy | Work |
|---|---|---|---|---|---|
| **A. WireGuard config import** (any provider's `.conf`; Proton VPN's free plan gives free WireGuard configs) | Fast (your provider's) | Free with Proton Free (5 countries), or any paid plan | The provider's | Strong | Medium: userspace WireGuard (`boringtun`) plus a small TCP stack (`smoltcp`) inside Kessel; no driver or admin rights |
| **B. Tor (`arti`, the Tor Project's Rust client)** | Slow (hundreds of ms); some sites show captchas | Free, no account | Random exit; no country choice | Strongest (anonymity) | Small: Kessel gets a stream to host:port from arti. About +10 MB to the exe, and a longer build |
| C. Cloudflare WARP | Fast | Free | Nearest only; it doesn't move your country | Hides your IP from sites, not from Cloudflare | Same engine as A, but signing up uses WARP's unofficial client API (against its terms, could break) |

**Recommendation: A, then B as a "Private window with Tor"-style option.** A gives a real, fast, free VPN today (Proton Free) and works with any paid provider. B is the only option with no account at all.
