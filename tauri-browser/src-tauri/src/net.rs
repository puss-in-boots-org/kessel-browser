// Kessel's own network layer: secure DNS, sites through a proxy of their own,
// and the VPN (Settings -> Network).
//
// The engine takes its proxy once, as it starts. So when any of these is set
// up, it starts with Kessel's own proxy here on 127.0.0.1 -- and that decides,
// connection by connection, where each one goes: straight to the site (its
// name looked up over DNS-over-HTTPS or DNS-over-TLS), through the proxy you
// gave that site, or through the VPN server. All of that changes at once,
// without a restart; turning the layer itself on or off takes one.
//
// The VPN: a server of yours (or your VPN provider's) that speaks SOCKS5 or
// HTTP. The site's name goes to it rather than being looked up here, so no
// DNS question leaves your PC; addresses on your own network stay direct. If
// the server can't be reached, pages don't load -- they never quietly go
// around it. WebRTC (calls) goes through it too, not straight out.

use super::*;
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpListener, TcpStream, ToSocketAddrs};
use std::sync::RwLock;

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Upstream {
    Http { host: String, port: u16, auth: Option<String> },
    Socks5 { host: String, port: u16, login: Option<(String, String)> },
    // A WireGuard server, Kessel's own tunnel to it (wg.rs).
    WireGuard(Box<crate::wg::WgConfig>),
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Route {
    Direct,
    Via(Upstream),
}

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) enum Dns {
    #[default]
    System,
    // A DNS-over-HTTPS address (https://1.1.1.1/dns-query).
    Https(String),
    // A DNS-over-TLS server: host (or IP) and port.
    Tls(String, u16),
}

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Config {
    pub dns: Dns,
    // Not the system's DNS when the secure one fails.
    pub strict: bool,
    // A site (and its subdomains) -> where its connections go.
    pub sites: Vec<(String, Route)>,
    // The VPN, while it's on.
    pub vpn: Option<Upstream>,
    // Settings -> Network -> Proxy's own server, for the rest.
    pub default: Option<Upstream>,
}

static CONFIG: RwLock<Option<Config>> = RwLock::new(None);
static PORT: std::sync::OnceLock<u16> = std::sync::OnceLock::new();
static CACHE: Mutex<Option<HashMap<String, (Vec<IpAddr>, Instant)>>> = Mutex::new(None);
// The connections going through, to end when where they should go changes.
static OPEN: Mutex<Option<HashMap<u64, TcpStream>>> = Mutex::new(None);
static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

// --- What Settings says ----------------------------------------------------------------

// socks5://user:pass@host:port, http://user:pass@host:port or host:port.
pub(crate) fn parse_upstream(text: &str) -> Option<Upstream> {
    let text = text.trim();
    let with_scheme = if text.contains("://") { text.to_string() } else { format!("http://{text}") };
    let url = tauri::Url::parse(&with_scheme).ok()?;
    let host = url.host_str()?.trim_matches(['[', ']']).to_string();
    let user = percent_decode(url.username());
    let pass = url.password().map(percent_decode).unwrap_or_default();
    match url.scheme() {
        "socks5" | "socks5h" | "socks" => Some(Upstream::Socks5 { host, port: url.port().unwrap_or(1080), login: (!user.is_empty()).then(|| (user, pass)) }),
        "http" => {
            let auth = (!user.is_empty()).then(|| {
                use base64::Engine;
                base64::engine::general_purpose::STANDARD.encode(format!("{user}:{pass}"))
            });
            Some(Upstream::Http { host, port: url.port().unwrap_or(8080), auth })
        }
        _ => None,
    }
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

// The secure DNS services Settings offers, by name.
pub(crate) const DNS_PRESETS: [(&str, &str); 3] = [("cloudflare", "https://1.1.1.1/dns-query"), ("google", "https://8.8.8.8/dns-query"), ("quad9", "https://9.9.9.9:5053/dns-query")];

fn dns_from(choice: &str, server: &str) -> Dns {
    if let Some((_, url)) = DNS_PRESETS.iter().find(|(name, _)| *name == choice) {
        return Dns::Https(url.to_string());
    }
    if choice != "custom" {
        return Dns::System;
    }
    let server = server.trim();
    // (A test run's own DNS server is plain http.)
    let test_run = std::env::var_os("KESSEL_REMOTE_DEBUGGING_PORT").is_some();
    if server.starts_with("https://") || test_run && server.starts_with("http://") {
        Dns::Https(server.to_string())
    } else if let Some(rest) = server.strip_prefix("tls://") {
        let (host, port) = match rest.rsplit_once(':').filter(|(_, p)| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit())) {
            Some((h, p)) => (h.to_string(), p.parse().unwrap_or(853)),
            None => (rest.to_string(), 853),
        };
        let host = host.trim_matches(['[', ']']).to_string();
        if host.is_empty() {
            Dns::System
        } else {
            Dns::Tls(host, port)
        }
    } else {
        Dns::System
    }
}

fn network(features: &serde_json::Value) -> serde_json::Value {
    features.get("network").cloned().unwrap_or(serde_json::json!({}))
}

// The VPN servers you added: [{ id, name, url }] -- or, WireGuard ones,
// [{ id, name, kind: "wireguard", endpoint, public_key, address, dns }]
// (their private keys kept apart, wg.rs).
pub(crate) fn vpn_servers(features: &serde_json::Value) -> Vec<serde_json::Value> {
    network(features).pointer("/vpn/servers").and_then(|s| s.as_array()).cloned().unwrap_or_default()
}

fn surfshark_on(features: &serde_json::Value) -> bool {
    network(features).pointer("/vpn/surfshark").and_then(|v| v.as_bool()).unwrap_or(false)
}

// Yours, then -- with your Surfshark key -- every Surfshark location
// ("ss:<its host>").
pub(crate) fn all_servers(features: &serde_json::Value) -> Vec<serde_json::Value> {
    let mut out = vpn_servers(features);
    if surfshark_on(features) && crate::wg::surfshark_ready() {
        out.extend(crate::wg::locations().into_iter().map(|l| {
            serde_json::json!({ "id": format!("ss:{}", l.connection_name), "name": format!("{} · {}", l.country, l.location), "group": "surfshark", "country": l.country_code, "load": l.load })
        }));
    }
    out
}

// Where a server's connections go.
fn server_upstream(server: &serde_json::Value) -> Option<Upstream> {
    let text = |k: &str| server.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let id = text("id");
    if id.starts_with("ss:") {
        return crate::wg::surfshark_server(&id).map(|c| Upstream::WireGuard(Box::new(c)));
    }
    if text("kind") == "wireguard" {
        use base64::Engine;
        let decode = |k: &str| base64::engine::general_purpose::STANDARD.decode(text(k)).ok().and_then(|b| <[u8; 32]>::try_from(b).ok());
        let dns = server.get("dns").and_then(|d| d.as_array()).into_iter().flatten().filter_map(|d| d.as_str()?.parse().ok()).collect::<Vec<_>>();
        return Some(Upstream::WireGuard(Box::new(crate::wg::WgConfig {
            private_key: crate::wg::private_key(&id)?,
            peer_public: decode("public_key")?,
            preshared: decode("preshared_key"),
            endpoint: text("endpoint"),
            address: text("address").parse().ok()?,
            dns: if dns.is_empty() { vec![std::net::Ipv4Addr::new(1, 1, 1, 1)] } else { dns },
        })));
    }
    parse_upstream(&text("url"))
}

// Whether anything needs the layer: then the engine starts with it.
pub(crate) fn wanted(features: &serde_json::Value) -> bool {
    let n = network(features);
    let dns = n.get("dns").and_then(|v| v.as_str()).unwrap_or("system");
    let sites = n.get("sites").and_then(|s| s.as_array()).is_some_and(|s| !s.is_empty());
    dns != "system" || sites || !vpn_servers(features).is_empty() || surfshark_on(features)
}

pub(crate) fn config_from(features: &serde_json::Value) -> Config {
    let n = network(features);
    let text = |v: Option<&serde_json::Value>| v.and_then(|v| v.as_str()).unwrap_or("").to_string();
    let dns = dns_from(&text(n.get("dns")), &text(n.get("dns_server")));
    let sites = n
        .get("sites")
        .and_then(|s| s.as_array())
        .into_iter()
        .flatten()
        .filter_map(|s| {
            let site = text(s.get("site")).trim().trim_start_matches("*.").trim_start_matches('.').to_ascii_lowercase();
            let proxy = text(s.get("proxy"));
            let route = if proxy.trim() == "direct" { Route::Direct } else { Route::Via(parse_upstream(&proxy)?) };
            (!site.is_empty()).then_some((site, route))
        })
        .collect();
    let vpn_on = n.pointer("/vpn/on").and_then(|v| v.as_bool()).unwrap_or(false);
    let current = text(n.pointer("/vpn/current"));
    let servers = all_servers(features);
    let vpn = vpn_on.then(|| servers.iter().find(|s| text(s.get("id")) == current).or(servers.first()).and_then(server_upstream)).flatten();
    let proxy = features.get("proxy").cloned().unwrap_or_default();
    let default = (text(proxy.get("mode")) == "fixed").then(|| parse_upstream(&text(proxy.get("server")))).flatten();
    Config { dns, strict: n.get("dns_strict").and_then(|v| v.as_bool()).unwrap_or(false), sites, vpn, default }
}

// Addresses on this PC or your own network: never through the VPN.
fn local(host: &str) -> bool {
    let h = host.trim_matches(['[', ']']).to_ascii_lowercase();
    match h.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => ip.is_loopback() || ip.is_private() || ip.is_link_local(),
        Ok(IpAddr::V6(ip)) => ip.is_loopback() || (ip.segments()[0] & 0xfe00) == 0xfc00 || (ip.segments()[0] & 0xffc0) == 0xfe80,
        Err(_) => h == "localhost" || h.ends_with(".localhost") || h.ends_with(".local") || h.ends_with(".lan") || !h.contains('.'),
    }
}

impl Config {
    // Where a connection to `host` goes.
    pub(crate) fn route(&self, host: &str) -> Route {
        let h = host.trim_matches(['[', ']']).trim_end_matches('.').to_ascii_lowercase();
        // The most specific site rule first.
        let rule = self.sites.iter().filter(|(site, _)| h == *site || h.ends_with(&format!(".{site}"))).max_by_key(|(site, _)| site.len());
        if let Some((_, route)) = rule {
            return route.clone();
        }
        if local(&h) {
            return Route::Direct;
        }
        if let Some(vpn) = &self.vpn {
            return Route::Via(vpn.clone());
        }
        match &self.default {
            Some(up) => Route::Via(up.clone()),
            None => Route::Direct,
        }
    }
}

fn config() -> Config {
    CONFIG.read().unwrap().clone().unwrap_or_default()
}

// Settings changed: where connections go from now on. The ones going
// through now end (the engine opens them again, the new way) when that
// changed -- a page mustn't go on around the VPN you just turned on.
pub(crate) fn apply(features: &serde_json::Value) {
    if !running() {
        return;
    }
    let next = config_from(features);
    let (changed, vpn_changed) = {
        let mut current = CONFIG.write().unwrap();
        let changed = current.as_ref() != Some(&next);
        let vpn_changed = current.as_ref().map(|c| &c.vpn) != Some(&next.vpn);
        *current = Some(next);
        (changed, vpn_changed)
    };
    if vpn_changed {
        crate::wg::stop();
    }
    if changed {
        clear_dns_cache();
        close_open();
    }
}

fn close_open() {
    let open: Vec<TcpStream> = OPEN.lock().unwrap().as_mut().map(|m| m.drain().map(|(_, s)| s).collect()).unwrap_or_default();
    for s in open {
        let _ = s.shutdown(std::net::Shutdown::Both);
    }
}

pub(crate) fn clear_dns_cache() {
    *CACHE.lock().unwrap() = None;
}

// --- The engine's side ---------------------------------------------------------------

// As Kessel starts: the layer, when something needs it (before the engine's
// command line is decided).
pub(crate) fn start(features: &serde_json::Value) {
    if !wanted(features) {
        return;
    }
    *CONFIG.write().unwrap() = Some(config_from(features));
    let Ok(listener) = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)) else { return };
    let Ok(port) = listener.local_addr().map(|a| a.port()) else { return };
    let _ = PORT.set(port);
    std::thread::spawn(move || {
        for client in listener.incoming().flatten() {
            std::thread::spawn(move || serve(client));
        }
    });
}

pub(crate) fn running() -> bool {
    PORT.get().is_some()
}

// The engine's switches: its proxy is this layer (and WebRTC goes through it
// when there's a VPN, rather than straight out).
pub(crate) fn engine_flags(features: &serde_json::Value) -> String {
    let Some(port) = PORT.get() else { return String::new() };
    let mut out = format!(" --proxy-server=http://127.0.0.1:{port}");
    if !vpn_servers(features).is_empty() || surfshark_on(features) {
        out.push_str(" --force-webrtc-ip-handling-policy=disable_non_proxied_udp");
    }
    out
}

// --- Connections ----------------------------------------------------------------------

const HEAD_LIMIT: usize = 64 * 1024;

// The request's head (up to the blank line) and whatever came after it.
fn read_head(stream: &mut TcpStream) -> std::io::Result<(Vec<u8>, Vec<u8>)> {
    let mut buf = Vec::with_capacity(2048);
    let mut chunk = [0u8; 4096];
    loop {
        let n = stream.read(&mut chunk)?;
        if n == 0 {
            return Err(std::io::ErrorKind::UnexpectedEof.into());
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            let rest = buf.split_off(end + 4);
            return Ok((buf, rest));
        }
        if buf.len() > HEAD_LIMIT {
            return Err(std::io::ErrorKind::InvalidData.into());
        }
    }
}

// "host:port" (or "[v6]:port") -> its parts.
fn host_port(target: &str, default_port: u16) -> Option<(String, u16)> {
    if let Some(rest) = target.strip_prefix('[') {
        let (host, after) = rest.split_once(']')?;
        let port = match after.strip_prefix(':') {
            Some(p) => p.parse().ok()?,
            None => default_port,
        };
        return Some((host.to_string(), port));
    }
    match target.rsplit_once(':') {
        Some((host, port)) => Some((host.to_string(), port.parse().ok()?)),
        None => Some((target.to_string(), default_port)),
    }
}

fn refuse(client: &mut TcpStream, why: &str) {
    let body = format!("Kessel couldn't connect: {why}\n");
    let _ = write!(client, "HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
}

fn serve(mut client: TcpStream) {
    let _ = client.set_read_timeout(Some(Duration::from_secs(30)));
    let Ok((head, rest)) = read_head(&mut client) else { return };
    let _ = client.set_read_timeout(None);
    let text = String::from_utf8_lossy(&head).to_string();
    let mut lines = text.split("\r\n");
    let first = lines.next().unwrap_or("");
    let mut parts = first.split(' ');
    let (method, target, version) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""), parts.next().unwrap_or("HTTP/1.1"));
    if method.eq_ignore_ascii_case("CONNECT") {
        let Some((host, port)) = host_port(target, 443) else { return refuse(&mut client, "a bad address") };
        match open(&host, port) {
            Ok(server) => {
                if client.write_all(b"HTTP/1.1 200 Connection established\r\n\r\n").is_ok() {
                    pipe(client, server, &rest);
                }
            }
            Err(e) => refuse(&mut client, &e.to_string()),
        }
        return;
    }
    // Plain http: the request goes on as the site expects it (just its
    // path), and the connection ends with its answer -- the next request
    // may be for another site.
    let Ok(url) = tauri::Url::parse(target) else { return refuse(&mut client, "a bad address") };
    let Some(host) = url.host_str().map(str::to_string) else { return refuse(&mut client, "a bad address") };
    let port = url.port_or_known_default().unwrap_or(80);
    let path = match url.query() {
        Some(q) => format!("{}?{}", url.path(), q),
        None => url.path().to_string(),
    };
    let mut out = format!("{method} {path} {version}\r\n");
    for line in lines.filter(|l| !l.is_empty()) {
        let name = line.split(':').next().unwrap_or("").trim().to_ascii_lowercase();
        if name.starts_with("proxy-") || name == "connection" || name == "keep-alive" {
            continue;
        }
        out.push_str(line);
        out.push_str("\r\n");
    }
    out.push_str("Connection: close\r\n\r\n");
    match open(&host, port) {
        Ok(mut server) => {
            if server.write_all(out.as_bytes()).is_ok() {
                pipe(client, server, &rest);
            }
        }
        Err(e) => refuse(&mut client, &e.to_string()),
    }
}

// Both ways, until either end closes.
fn pipe(client: TcpStream, mut server: TcpStream, early: &[u8]) {
    if !early.is_empty() && server.write_all(early).is_err() {
        return;
    }
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    if let Ok(c) = client.try_clone() {
        OPEN.lock().unwrap().get_or_insert_with(HashMap::new).insert(id, c);
    }
    let (Ok(mut client_r), Ok(mut server_w)) = (client.try_clone(), server.try_clone()) else { return };
    let up = std::thread::spawn(move || {
        let _ = std::io::copy(&mut client_r, &mut server_w);
        let _ = server_w.shutdown(std::net::Shutdown::Write);
    });
    let mut client_w = client;
    let _ = std::io::copy(&mut server, &mut client_w);
    let _ = client_w.shutdown(std::net::Shutdown::Both);
    let _ = up.join();
    if let Some(open) = OPEN.lock().unwrap().as_mut() {
        open.remove(&id);
    }
}

const CONNECT_TIMEOUT: Duration = Duration::from_secs(12);

fn open(host: &str, port: u16) -> std::io::Result<TcpStream> {
    let stream = match config().route(host) {
        Route::Direct => connect_direct(host, port)?,
        Route::Via(up) => connect_via(&up, host, port)?,
    };
    let _ = stream.set_nodelay(true);
    Ok(stream)
}

fn connect_addrs(addrs: &[SocketAddr]) -> std::io::Result<TcpStream> {
    let mut last = std::io::Error::new(std::io::ErrorKind::NotFound, "no address for that name");
    for addr in addrs {
        match TcpStream::connect_timeout(addr, CONNECT_TIMEOUT) {
            Ok(s) => return Ok(s),
            Err(e) => last = e,
        }
    }
    Err(last)
}

fn connect_direct(host: &str, port: u16) -> std::io::Result<TcpStream> {
    let ips = resolve(host)?;
    connect_addrs(&ips.into_iter().map(|ip| SocketAddr::new(ip, port)).collect::<Vec<_>>())
}

// The VPN or proxy server itself is found by the system's DNS (or given
// as an address).
fn connect_server(host: &str, port: u16) -> std::io::Result<TcpStream> {
    let addrs: Vec<SocketAddr> = match host.parse::<IpAddr>() {
        Ok(ip) => vec![SocketAddr::new(ip, port)],
        Err(_) => (host, port).to_socket_addrs()?.collect(),
    };
    connect_addrs(&addrs)
}

fn fail(why: impl Into<String>) -> std::io::Error {
    std::io::Error::other(why.into())
}

// Whether a server can be used: it answers, and (SOCKS5) takes the name and
// password -- without going anywhere through it yet.
fn check(up: &Upstream) -> std::io::Result<()> {
    match up {
        Upstream::WireGuard(cfg) => crate::wg::check(cfg),
        Upstream::Http { host, port, .. } => connect_server(host, *port).map(|_| ()).map_err(|e| fail(format!("the server {host}:{port} can't be reached ({e})"))),
        Upstream::Socks5 { host, port, login } => {
            let mut s = connect_server(host, *port).map_err(|e| fail(format!("the VPN server {host}:{port} can't be reached ({e})")))?;
            let _ = s.set_read_timeout(Some(CONNECT_TIMEOUT));
            socks_sign_in(&mut s, login)
        }
    }
}

fn socks_sign_in(s: &mut TcpStream, login: &Option<(String, String)>) -> std::io::Result<()> {
    s.write_all(if login.is_some() { &[5, 2, 0, 2] } else { &[5, 1, 0] })?;
    let mut reply = [0u8; 2];
    s.read_exact(&mut reply)?;
    match (reply[1], login) {
        (0, _) => Ok(()),
        (2, Some((user, pass))) => {
            let (user, pass) = (&user.as_bytes()[..user.len().min(255)], &pass.as_bytes()[..pass.len().min(255)]);
            let mut auth = vec![1, user.len() as u8];
            auth.extend_from_slice(user);
            auth.push(pass.len() as u8);
            auth.extend_from_slice(pass);
            s.write_all(&auth)?;
            s.read_exact(&mut reply)?;
            if reply[1] != 0 {
                return Err(fail("the VPN server didn't take the name and password"));
            }
            Ok(())
        }
        _ => Err(fail("the VPN server wants a sign-in Kessel doesn't have")),
    }
}

pub(crate) fn connect_via(up: &Upstream, host: &str, port: u16) -> std::io::Result<TcpStream> {
    let host = host.trim_matches(['[', ']']);
    match up {
        Upstream::WireGuard(cfg) => crate::wg::connect(cfg, host, port),
        Upstream::Http { host: ph, port: pp, auth } => {
            let mut s = connect_server(ph, *pp).map_err(|e| fail(format!("the proxy server {ph}:{pp} can't be reached ({e})")))?;
            let target = if host.contains(':') { format!("[{host}]:{port}") } else { format!("{host}:{port}") };
            let mut req = format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n");
            if let Some(a) = auth {
                req.push_str(&format!("Proxy-Authorization: Basic {a}\r\n"));
            }
            req.push_str("\r\n");
            s.write_all(req.as_bytes())?;
            let _ = s.set_read_timeout(Some(CONNECT_TIMEOUT));
            let (head, rest) = read_head(&mut s)?;
            let _ = s.set_read_timeout(None);
            let status = String::from_utf8_lossy(&head).split_whitespace().nth(1).unwrap_or("").to_string();
            if status != "200" || !rest.is_empty() {
                return Err(fail(format!("the proxy server said no ({status})")));
            }
            Ok(s)
        }
        Upstream::Socks5 { host: ph, port: pp, login } => {
            let mut s = connect_server(ph, *pp).map_err(|e| fail(format!("the VPN server {ph}:{pp} can't be reached ({e})")))?;
            let _ = s.set_read_timeout(Some(CONNECT_TIMEOUT));
            socks_sign_in(&mut s, login)?;
            // The name, not an address: it's looked up at the server.
            let mut req = vec![5, 1, 0];
            match host.parse::<IpAddr>() {
                Ok(IpAddr::V4(ip)) => {
                    req.push(1);
                    req.extend_from_slice(&ip.octets());
                }
                Ok(IpAddr::V6(ip)) => {
                    req.push(4);
                    req.extend_from_slice(&ip.octets());
                }
                Err(_) => {
                    let name = &host.as_bytes()[..host.len().min(255)];
                    req.push(3);
                    req.push(name.len() as u8);
                    req.extend_from_slice(name);
                }
            }
            req.extend_from_slice(&port.to_be_bytes());
            s.write_all(&req)?;
            let mut head = [0u8; 4];
            s.read_exact(&mut head)?;
            if head[1] != 0 {
                return Err(fail(format!("the VPN server couldn't reach {host} (error {})", head[1])));
            }
            let skip = match head[3] {
                1 => 4,
                4 => 16,
                3 => {
                    let mut len = [0u8; 1];
                    s.read_exact(&mut len)?;
                    len[0] as usize
                }
                _ => return Err(fail("the VPN server answered strangely")),
            };
            let mut rest = vec![0u8; skip + 2];
            s.read_exact(&mut rest)?;
            let _ = s.set_read_timeout(None);
            Ok(s)
        }
    }
}

// --- DNS -------------------------------------------------------------------------------

pub(crate) fn resolve(host: &str) -> std::io::Result<Vec<IpAddr>> {
    let host = host.trim_matches(['[', ']']).trim_end_matches('.').to_ascii_lowercase();
    if let Ok(ip) = host.parse::<IpAddr>() {
        return Ok(vec![ip]);
    }
    if host == "localhost" || host.ends_with(".localhost") {
        return Ok(vec![IpAddr::V4(Ipv4Addr::LOCALHOST), IpAddr::V6(Ipv6Addr::LOCALHOST)]);
    }
    if let Some((ips, until)) = CACHE.lock().unwrap().as_ref().and_then(|c| c.get(&host).cloned()) {
        if until > Instant::now() {
            return Ok(ips);
        }
    }
    let cfg = config();
    let secure = match &cfg.dns {
        Dns::System => None,
        Dns::Https(url) => Some(ask_https(url, &host)),
        Dns::Tls(server, port) => Some(ask_tls(server, *port, &host)),
    };
    let (ips, ttl) = match secure {
        Some(Ok(found)) if !found.0.is_empty() => found,
        Some(Ok(_)) => return Err(fail(format!("{host} doesn't exist (secure DNS)"))),
        Some(Err(e)) if cfg.strict => return Err(fail(format!("secure DNS didn't answer ({e})"))),
        _ => ((host.as_str(), 0).to_socket_addrs()?.map(|a| a.ip()).collect::<Vec<_>>(), 60),
    };
    let ttl = Duration::from_secs(u64::from(ttl).clamp(30, 600));
    CACHE.lock().unwrap().get_or_insert_with(HashMap::new).insert(host, (ips.clone(), Instant::now() + ttl));
    Ok(ips)
}

// A DNS question for `host`'s addresses of type `kind` (1: IPv4, 28: IPv6).
pub(crate) fn dns_query(id: u16, host: &str, kind: u16) -> Vec<u8> {
    let mut q = Vec::with_capacity(32 + host.len());
    q.extend_from_slice(&id.to_be_bytes());
    q.extend_from_slice(&[0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]); // recursion wanted; one question
    for label in host.split('.').filter(|l| !l.is_empty()) {
        let label = &label.as_bytes()[..label.len().min(63)];
        q.push(label.len() as u8);
        q.extend_from_slice(label);
    }
    q.push(0);
    q.extend_from_slice(&kind.to_be_bytes());
    q.extend_from_slice(&1u16.to_be_bytes()); // class IN
    q
}

// The addresses in a DNS answer (and the shortest time to keep them).
// Some(empty): the name doesn't exist. None: not an answer.
pub(crate) fn dns_answers(msg: &[u8]) -> Option<(Vec<IpAddr>, u32)> {
    if msg.len() < 12 || msg[2] & 0x80 == 0 {
        return None;
    }
    let rcode = msg[3] & 0x0f;
    if rcode == 3 {
        return Some((Vec::new(), 60));
    }
    if rcode != 0 {
        return None;
    }
    let qd = u16::from_be_bytes([msg[4], msg[5]]);
    let an = u16::from_be_bytes([msg[6], msg[7]]);
    let skip_name = |mut pos: usize| -> Option<usize> {
        loop {
            let len = *msg.get(pos)? as usize;
            if len & 0xc0 == 0xc0 {
                return Some(pos + 2);
            }
            if len == 0 {
                return Some(pos + 1);
            }
            pos += 1 + len;
        }
    };
    let mut pos = 12;
    for _ in 0..qd {
        pos = skip_name(pos)? + 4;
    }
    let (mut ips, mut ttl) = (Vec::new(), u32::MAX);
    for _ in 0..an {
        pos = skip_name(pos)?;
        let field = msg.get(pos..pos + 10)?;
        let kind = u16::from_be_bytes([field[0], field[1]]);
        let t = u32::from_be_bytes([field[4], field[5], field[6], field[7]]);
        let len = u16::from_be_bytes([field[8], field[9]]) as usize;
        let data = msg.get(pos + 10..pos + 10 + len)?;
        match (kind, len) {
            (1, 4) => ips.push(IpAddr::V4(Ipv4Addr::new(data[0], data[1], data[2], data[3]))),
            (28, 16) => ips.push(IpAddr::V6(Ipv6Addr::from(<[u8; 16]>::try_from(data).ok()?))),
            _ => {}
        }
        if matches!(kind, 1 | 28) {
            ttl = ttl.min(t);
        }
        pos += 10 + len;
    }
    Some((ips, if ttl == u32::MAX { 60 } else { ttl }))
}

fn doh_agent() -> &'static ureq::Agent {
    static AGENT: std::sync::OnceLock<ureq::Agent> = std::sync::OnceLock::new();
    AGENT.get_or_init(|| {
        use ureq::tls::{RootCerts, TlsConfig, TlsProvider};
        ureq::Agent::config_builder()
            .tls_config(TlsConfig::builder().provider(TlsProvider::NativeTls).root_certs(RootCerts::PlatformVerifier).build())
            .timeout_global(Some(Duration::from_secs(5)))
            .build()
            .into()
    })
}

// Both kinds of address, IPv4 first; an answer for either is enough.
fn ask_both(mut ask: impl FnMut(u16) -> std::io::Result<(Vec<IpAddr>, u32)>) -> std::io::Result<(Vec<IpAddr>, u32)> {
    let v4 = ask(1);
    let v6 = ask(28);
    match (v4, v6) {
        (Ok((mut a, ta)), Ok((b, tb))) => {
            a.extend(b);
            Ok((a, ta.min(tb)))
        }
        (Ok(found), Err(_)) | (Err(_), Ok(found)) => Ok(found),
        (Err(e), Err(_)) => Err(e),
    }
}

fn ask_https(url: &str, host: &str) -> std::io::Result<(Vec<IpAddr>, u32)> {
    use base64::Engine;
    ask_both(|kind| {
        // (Id 0, as RFC 8484 asks: answers can be cached.)
        let q = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(dns_query(0, host, kind));
        let sep = if url.contains('?') { '&' } else { '?' };
        let mut response = doh_agent().get(format!("{url}{sep}dns={q}")).header("Accept", "application/dns-message").call().map_err(|e| fail(e.to_string()))?;
        let body = response.body_mut().with_config().limit(65535).read_to_vec().map_err(|e| fail(e.to_string()))?;
        dns_answers(&body).ok_or_else(|| fail("not a DNS answer"))
    })
}

#[cfg(windows)]
fn ask_tls(server: &str, port: u16, host: &str) -> std::io::Result<(Vec<IpAddr>, u32)> {
    let tcp = connect_server(server, port)?;
    let _ = tcp.set_read_timeout(Some(Duration::from_secs(5)));
    let connector = native_tls::TlsConnector::new().map_err(|e| fail(e.to_string()))?;
    let mut tls = connector.connect(server, tcp).map_err(|e| fail(e.to_string()))?;
    ask_both(|kind| {
        let q = dns_query(rand::random(), host, kind);
        tls.write_all(&(q.len() as u16).to_be_bytes())?;
        tls.write_all(&q)?;
        let mut len = [0u8; 2];
        tls.read_exact(&mut len)?;
        let mut msg = vec![0u8; u16::from_be_bytes(len) as usize];
        tls.read_exact(&mut msg)?;
        dns_answers(&msg).ok_or_else(|| fail("not a DNS answer"))
    })
}

#[cfg(not(windows))]
fn ask_tls(_server: &str, _port: u16, _host: &str) -> std::io::Result<(Vec<IpAddr>, u32)> {
    Err(fail("DNS-over-TLS is Windows-only"))
}

// --- Commands --------------------------------------------------------------------------

fn features(app: &tauri::AppHandle) -> serde_json::Value {
    app.state::<BrowserState>().store.settings.lock().unwrap().features.clone()
}

// What Settings and the VPN button show.
#[tauri::command]
pub(crate) fn net_status(app: tauri::AppHandle, webview: Webview) -> Result<serde_json::Value, String> {
    require_internal_page(&webview)?;
    let f = features(&app);
    let n = network(&f);
    let servers: Vec<serde_json::Value> = all_servers(&f).iter().map(|s| serde_json::json!({ "id": s.get("id"), "name": s.get("name"), "group": s.get("group"), "country": s.get("country"), "load": s.get("load"), "kind": s.get("kind") })).collect();
    Ok(serde_json::json!({
        "running": running(),
        "wanted": wanted(&f),
        "vpn": {
            "on": running() && config().vpn.is_some(),
            "current": n.pointer("/vpn/current"),
            "recent": n.pointer("/vpn/recent"),
            "surfshark": surfshark_on(&f) && crate::wg::surfshark_ready(),
            "servers": servers,
        },
    }))
}

// Changes features.network.vpn, saves, and says so everywhere.
fn change_vpn(app: &tauri::AppHandle, change: impl FnOnce(&mut serde_json::Map<String, serde_json::Value>)) {
    let state = app.state::<BrowserState>();
    let mut f = features(app);
    if !f.is_object() {
        f = serde_json::json!({});
    }
    let obj = f.as_object_mut().unwrap();
    let network = obj.entry("network").or_insert_with(|| serde_json::json!({}));
    if !network.is_object() {
        *network = serde_json::json!({});
    }
    let vpn = network.as_object_mut().unwrap().entry("vpn").or_insert_with(|| serde_json::json!({}));
    if !vpn.is_object() {
        *vpn = serde_json::json!({});
    }
    change(vpn.as_object_mut().unwrap());
    let settings = {
        let mut s = state.store.settings.lock().unwrap();
        s.features = f.clone();
        s.clone()
    };
    state.store.save_settings();
    let _ = app.emit("settings-changed", &settings);
    apply(&f);
}

fn set_vpn(app: &tauri::AppHandle, on: bool, server: Option<String>) -> Result<serde_json::Value, String> {
    let f = features(app);
    let servers = all_servers(&f);
    let id_of = |s: &serde_json::Value| s.get("id").and_then(|v| v.as_str()).map(str::to_string);
    let current = server.or_else(|| network(&f).pointer("/vpn/current").and_then(|v| v.as_str()).map(str::to_string)).filter(|id| servers.iter().any(|s| id_of(s).as_deref() == Some(id))).or_else(|| servers.first().and_then(id_of));
    let chosen = servers.iter().find(|s| id_of(s) == current).ok_or("Add a VPN server first: Settings -> Network")?;
    if on {
        if !running() {
            return Err("Restart Kessel first: the VPN takes over its connections from the start".into());
        }
        // Reachable, and willing to take us somewhere, before anything goes
        // its way.
        let up = server_upstream(chosen).ok_or("That server isn't one Kessel can use (its key is missing?)")?;
        check(&up).map_err(|e| e.to_string())?;
    }
    change_vpn(app, |v| {
        v.insert("on".into(), serde_json::Value::Bool(on));
        if let Some(id) = &current {
            v.insert("current".into(), serde_json::Value::String(id.clone()));
            // The last few you went through, for the VPN button's menu.
            let mut recent: Vec<serde_json::Value> = v.get("recent").and_then(|r| r.as_array()).cloned().unwrap_or_default();
            recent.retain(|r| r.as_str() != Some(id.as_str()));
            recent.insert(0, serde_json::Value::String(id.clone()));
            recent.truncate(6);
            v.insert("recent".into(), serde_json::Value::Array(recent));
        }
    });
    let status = serde_json::json!({ "on": on && config().vpn.is_some(), "current": current, "name": chosen.get("name") });
    let _ = app.emit("vpn-changed", status.clone());
    Ok(status)
}

// A WireGuard config file from your VPN service, as one of your servers
// (its private key kept apart, for your Windows account).
#[tauri::command]
pub(crate) fn vpn_add_wireguard(app: tauri::AppHandle, webview: Webview, name: String, conf: String) -> Result<String, String> {
    require_internal_page(&webview)?;
    let c = crate::wg::parse_conf(&conf)?;
    use base64::Engine;
    let b64 = |k: &[u8; 32]| base64::engine::general_purpose::STANDARD.encode(k);
    let id = format!("wg{:x}", rand::random::<u32>());
    crate::wg::set_private_key(&id, Some(&b64(&c.private_key)))?;
    let mut server = serde_json::json!({
        "id": id, "name": name.trim(), "kind": "wireguard", "endpoint": c.endpoint, "public_key": b64(&c.peer_public),
        "address": c.address.to_string(), "dns": c.dns.iter().map(|d| d.to_string()).collect::<Vec<_>>(),
    });
    if let Some(p) = &c.preshared {
        server["preshared_key"] = serde_json::Value::String(b64(p));
    }
    change_vpn(&app, |v| {
        let servers = v.entry("servers").or_insert_with(|| serde_json::json!([]));
        if let Some(list) = servers.as_array_mut() {
            list.push(server);
        }
        v.entry("current").or_insert_with(|| serde_json::Value::String(id.clone()));
    });
    Ok(id)
}

// One of your servers removed (Settings): its key goes too.
#[tauri::command]
pub(crate) fn vpn_remove_server(app: tauri::AppHandle, webview: Webview, id: String) -> Result<(), String> {
    require_internal_page(&webview)?;
    let _ = crate::wg::set_private_key(&id, None);
    change_vpn(&app, |v| {
        if let Some(list) = v.get_mut("servers").and_then(|s| s.as_array_mut()) {
            list.retain(|s| s.get("id").and_then(|i| i.as_str()) != Some(id.as_str()));
        }
        if v.get("current").and_then(|c| c.as_str()) == Some(id.as_str()) {
            v.insert("on".into(), serde_json::Value::Bool(false));
            v.remove("current");
        }
    });
    Ok(())
}

// Surfshark: your account's WireGuard private key (my.surfshark.com ->
// VPN -> Manual setup -> WireGuard -> "I don't have a key pair"), and every
// location of theirs is a server here.
#[tauri::command]
pub(crate) async fn surfshark_connect(app: tauri::AppHandle, webview: Webview, private_key: String) -> Result<serde_json::Value, String> {
    require_internal_page(&webview)?;
    tauri::async_runtime::spawn_blocking(move || {
        use base64::Engine;
        let ok = base64::engine::general_purpose::STANDARD.decode(private_key.trim()).is_ok_and(|b| b.len() == 32);
        if !ok {
            return Err("That isn't a WireGuard private key (44 characters, ending in =)".to_string());
        }
        let n = crate::wg::refresh_locations()?;
        crate::wg::set_private_key(crate::wg::SURFSHARK, Some(&private_key))?;
        change_vpn(&app, |v| {
            v.insert("surfshark".into(), serde_json::Value::Bool(true));
        });
        Ok(serde_json::json!({ "locations": n, "restart": !running() }))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) fn surfshark_disconnect(app: tauri::AppHandle, webview: Webview) -> Result<(), String> {
    require_internal_page(&webview)?;
    let _ = crate::wg::set_private_key(crate::wg::SURFSHARK, None);
    change_vpn(&app, |v| {
        v.insert("surfshark".into(), serde_json::Value::Bool(false));
        if v.get("current").and_then(|c| c.as_str()).is_some_and(|c| c.starts_with("ss:")) {
            v.insert("on".into(), serde_json::Value::Bool(false));
            v.remove("current");
        }
    });
    Ok(())
}

// Surfshark's locations (fresh from Surfshark when asked).
#[tauri::command]
pub(crate) async fn surfshark_locations(webview: Webview, refresh: Option<bool>) -> Result<Vec<crate::wg::Location>, String> {
    require_internal_page(&webview)?;
    tauri::async_runtime::spawn_blocking(move || {
        if refresh.unwrap_or(false) || crate::wg::locations().is_empty() {
            crate::wg::refresh_locations()?;
        }
        Ok(crate::wg::locations())
    })
    .await
    .map_err(|e| e.to_string())?
}

// The VPN button: on or off (`server`: through that one of yours).
#[tauri::command]
pub(crate) async fn vpn_set(app: tauri::AppHandle, webview: Webview, on: bool, server: Option<String>) -> Result<serde_json::Value, String> {
    require_internal_page(&webview)?;
    tauri::async_runtime::spawn_blocking(move || set_vpn(&app, on, server)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) fn net_clear_dns(webview: Webview) -> Result<(), String> {
    require_internal_page(&webview)?;
    clear_dns_cache();
    Ok(())
}

// Settings -> Network -> Secure DNS -> Test: what the DNS in use says.
#[tauri::command]
pub(crate) async fn net_lookup(webview: Webview, host: String) -> Result<Vec<String>, String> {
    require_internal_page(&webview)?;
    tauri::async_runtime::spawn_blocking(move || resolve(host.trim()).map(|ips| ips.iter().map(IpAddr::to_string).collect()).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn where_connections_go() {
        let f = serde_json::json!({
            "proxy": { "mode": "fixed", "server": "corp:3128" },
            "network": {
                "dns": "custom", "dns_server": "tls://dns.example:8853",
                "sites": [{ "site": "*.example.com", "proxy": "socks5://a:b%40c@127.0.0.1:9050" }, { "site": "direct.example.com", "proxy": "direct" }],
                "vpn": { "on": true, "current": "b", "servers": [{ "id": "a", "url": "socks5://a.example" }, { "id": "b", "name": "Home", "url": "http://me:pw@home.example:8888" }] }
            }
        });
        assert!(wanted(&f));
        let c = config_from(&f);
        assert_eq!(c.dns, Dns::Tls("dns.example".into(), 8853));
        let socks = Upstream::Socks5 { host: "127.0.0.1".into(), port: 9050, login: Some(("a".into(), "b@c".into())) };
        assert_eq!(c.route("www.example.com"), Route::Via(socks.clone()), "a site's own proxy");
        assert_eq!(c.route("example.com"), Route::Via(socks));
        assert_eq!(c.route("direct.example.com"), Route::Direct, "the more specific rule wins");
        let home = Upstream::Http { host: "home.example".into(), port: 8888, auth: Some("bWU6cHc=".into()) };
        assert_eq!(c.route("news.example.org"), Route::Via(home), "the VPN's chosen server");
        for local in ["localhost", "192.168.1.10", "10.0.0.2", "printer", "nas.local", "[::1]"] {
            assert_eq!(c.route(local), Route::Direct, "{local} stays on your own network");
        }
        // VPN off: the proxy from Settings -> Network -> Proxy.
        let mut off = f.clone();
        off["network"]["vpn"]["on"] = serde_json::json!(false);
        assert_eq!(config_from(&off).route("news.example.org"), Route::Via(Upstream::Http { host: "corp".into(), port: 3128, auth: None }));
        assert!(!wanted(&serde_json::json!({ "network": { "dns": "system" } })), "nothing to do");
        assert_eq!(dns_from("cloudflare", ""), Dns::Https("https://1.1.1.1/dns-query".into()));
        assert_eq!(dns_from("custom", "https://dns.example/q"), Dns::Https("https://dns.example/q".into()));
        assert_eq!(dns_from("custom", "tls://1.1.1.1"), Dns::Tls("1.1.1.1".into(), 853));
        assert_eq!(dns_from("custom", "8.8.8.8"), Dns::System, "a plain address isn't secure DNS");
        assert_eq!(parse_upstream("ftp://x"), None);
    }

    #[test]
    fn dns_questions_and_answers() {
        let q = dns_query(0x1234, "a.example", 1);
        assert_eq!(&q[..4], &[0x12, 0x34, 0x01, 0x00]);
        assert_eq!(&q[12..], &[1, b'a', 7, b'e', b'x', b'a', b'm', b'p', b'l', b'e', 0, 0, 1, 0, 1]);
        // The answer: the question back, then one A record (by a pointer to
        // the name) with a TTL of 300.
        let mut a = q.clone();
        a[2] = 0x81;
        a[3] = 0x80;
        a[7] = 1;
        a.extend_from_slice(&[0xc0, 12, 0, 1, 0, 1, 0, 0, 1, 44, 0, 4, 93, 184, 216, 34]);
        assert_eq!(dns_answers(&a), Some((vec!["93.184.216.34".parse().unwrap()], 300)));
        let mut nx = q.clone();
        nx[2] = 0x81;
        nx[3] = 0x83;
        assert_eq!(dns_answers(&nx), Some((vec![], 60)), "no such name");
        assert_eq!(dns_answers(&q), None, "a question isn't an answer");
    }
}
