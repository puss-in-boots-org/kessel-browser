// WireGuard inside Kessel: the VPN's servers can be WireGuard ones -- a
// config file from your VPN service, or Surfshark's locations with your
// Surfshark key (below). No driver and no admin rights: Kessel speaks
// WireGuard itself (boringtun) over UDP, with a small TCP/IP stack of its own
// (smoltcp) for the connections that go through it, and only the browser's
// connections do. Names are looked up through the tunnel, at the VPN's DNS.
//
// One engine thread per server in use. A connection through it is a pair of
// local sockets: net.rs gets one end like any other connection, the engine
// carries the other through the tunnel.

use super::*;
use boringtun::noise::{Tunn, TunnResult};
use smoltcp::iface::{Config as IfaceConfig, Interface, SocketHandle, SocketSet};
use smoltcp::phy::{Device, DeviceCapabilities, Medium, RxToken, TxToken};
use smoltcp::socket::{tcp, udp};
use smoltcp::wire::{HardwareAddress, IpAddress, IpCidr, IpEndpoint, Ipv4Address};
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream, ToSocketAddrs, UdpSocket};
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::mpsc;
use std::sync::Arc;

#[derive(Clone, PartialEq)]
pub(crate) struct WgConfig {
    pub private_key: [u8; 32],
    pub peer_public: [u8; 32],
    pub preshared: Option<[u8; 32]>,
    // host:port
    pub endpoint: String,
    pub address: Ipv4Addr,
    pub dns: Vec<Ipv4Addr>,
}

// (Never the keys, in logs.)
impl std::fmt::Debug for WgConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "WireGuard({} as {})", self.endpoint, self.address)
    }
}

fn key(text: &str) -> Option<[u8; 32]> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(text.trim()).ok()?.try_into().ok()
}

// A WireGuard config file ([Interface] and one [Peer]), as VPN services
// give them out. Only what a browser's connections need: IPv4 inside the
// tunnel, everything through it.
pub(crate) fn parse_conf(text: &str) -> Result<WgConfig, String> {
    let mut section = String::new();
    let (mut private_key, mut peer_public, mut preshared, mut endpoint, mut address, mut dns) = (None, None, None, None, None, Vec::new());
    for line in text.lines() {
        let line = line.split('#').next().unwrap_or("").trim();
        if line.starts_with('[') {
            section = line.trim_matches(['[', ']']).trim().to_ascii_lowercase();
            continue;
        }
        let Some((k, v)) = line.split_once('=') else { continue };
        let (k, v) = (k.trim().to_ascii_lowercase(), v.trim());
        match (section.as_str(), k.as_str()) {
            ("interface", "privatekey") => private_key = key(v),
            ("interface", "address") => address = v.split(',').filter_map(|a| a.trim().split('/').next()?.parse::<Ipv4Addr>().ok()).next(),
            ("interface", "dns") => dns = v.split(',').filter_map(|a| a.trim().parse::<Ipv4Addr>().ok()).collect(),
            ("peer", "publickey") => peer_public = key(v),
            ("peer", "presharedkey") => preshared = key(v),
            ("peer", "endpoint") => endpoint = Some(v.to_string()),
            _ => {}
        }
    }
    Ok(WgConfig {
        private_key: private_key.ok_or("No PrivateKey in [Interface]")?,
        peer_public: peer_public.ok_or("No PublicKey in [Peer]")?,
        preshared,
        endpoint: endpoint.filter(|e| e.contains(':')).ok_or("No Endpoint (host:port) in [Peer]")?,
        address: address.ok_or("No IPv4 Address in [Interface]")?,
        dns: if dns.is_empty() { vec![Ipv4Addr::new(1, 1, 1, 1)] } else { dns },
    })
}

// --- Private keys, kept for your Windows account --------------------------------------

static KEYS: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);
static DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

fn keys_file() -> Option<PathBuf> {
    DIR.get().map(|d| d.join("vpn-keys.dat"))
}

pub(crate) fn load(data_dir: &Path) {
    let _ = DIR.set(data_dir.to_path_buf());
    let keys = keys_file()
        .and_then(|f| std::fs::read(f).ok())
        .and_then(|b| crate::forms::dpapi(&b, false).ok())
        .and_then(|b| serde_json::from_slice::<HashMap<String, String>>(&b).ok())
        .unwrap_or_default();
    *KEYS.lock().unwrap() = Some(keys);
}

pub(crate) fn private_key(id: &str) -> Option<[u8; 32]> {
    KEYS.lock().unwrap().as_ref()?.get(id).and_then(|k| key(k))
}

pub(crate) fn set_private_key(id: &str, value: Option<&str>) -> Result<(), String> {
    let mut guard = KEYS.lock().unwrap();
    let keys = guard.get_or_insert_with(HashMap::new);
    match value {
        Some(v) => {
            keys.insert(id.to_string(), v.trim().to_string());
        }
        None => {
            keys.remove(id);
        }
    }
    let file = keys_file().ok_or("Kessel hasn't started yet")?;
    let sealed = crate::forms::dpapi(&serde_json::to_vec(&*keys).map_err(|e| e.to_string())?, true)?;
    std::fs::write(file, sealed).map_err(|e| e.to_string())
}

// --- Surfshark ------------------------------------------------------------------------
// One key pair for your whole account (made at my.surfshark.com -> Manual
// setup -> WireGuard); every location is a server of theirs with its own
// public key, from their public list of locations.

pub(crate) const SURFSHARK: &str = "surfshark";
const SURFSHARK_LIST: &str = "https://api.surfshark.com/v4/server/clusters/generic";
const SURFSHARK_DNS: [Ipv4Addr; 2] = [Ipv4Addr::new(162, 252, 172, 57), Ipv4Addr::new(149, 154, 159, 92)];

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Location {
    pub connection_name: String,
    #[serde(default)]
    pub country: String,
    #[serde(default)]
    pub country_code: String,
    #[serde(default)]
    pub location: String,
    #[serde(default)]
    pub pub_key: String,
    #[serde(default)]
    pub load: u32,
}

static LOCATIONS: Mutex<Option<Vec<Location>>> = Mutex::new(None);

fn locations_file() -> Option<PathBuf> {
    DIR.get().map(|d| d.join("surfshark.json"))
}

pub(crate) fn locations() -> Vec<Location> {
    let mut cached = LOCATIONS.lock().unwrap();
    if cached.is_none() {
        *cached = locations_file().and_then(|f| std::fs::read_to_string(f).ok()).and_then(|t| serde_json::from_str(&t).ok());
    }
    cached.clone().unwrap_or_default()
}

// Surfshark's list of locations, fresh.
pub(crate) fn refresh_locations() -> Result<usize, String> {
    use ureq::tls::{RootCerts, TlsConfig, TlsProvider};
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .tls_config(TlsConfig::builder().provider(TlsProvider::NativeTls).root_certs(RootCerts::PlatformVerifier).build())
        .timeout_global(Some(Duration::from_secs(20)))
        .build()
        .into();
    let text = agent.get(SURFSHARK_LIST).call().map_err(|e| format!("Couldn't get Surfshark's locations: {e}"))?.body_mut().with_config().limit(8 * 1024 * 1024).read_to_string().map_err(|e| e.to_string())?;
    let mut list: Vec<Location> = serde_json::from_str(&text).map_err(|e| format!("Surfshark's list wasn't readable: {e}"))?;
    list.retain(|l| l.connection_name.ends_with(".surfshark.com") && key(&l.pub_key).is_some());
    list.sort_by(|a, b| (&a.country, &a.location).cmp(&(&b.country, &b.location)));
    if let Some(f) = locations_file() {
        let _ = store::write_atomic(&f, &serde_json::to_string(&list).unwrap_or_default());
    }
    let n = list.len();
    *LOCATIONS.lock().unwrap() = Some(list);
    Ok(n)
}

// A Surfshark location as a VPN server: "ss:<its host>".
pub(crate) fn surfshark_server(id: &str) -> Option<WgConfig> {
    let host = id.strip_prefix("ss:")?;
    let loc = locations().into_iter().find(|l| l.connection_name == host)?;
    Some(WgConfig { private_key: private_key(SURFSHARK)?, peer_public: key(&loc.pub_key)?, preshared: None, endpoint: format!("{host}:51820"), address: Ipv4Addr::new(10, 14, 0, 2), dns: SURFSHARK_DNS.to_vec() })
}

pub(crate) fn surfshark_ready() -> bool {
    private_key(SURFSHARK).is_some()
}

// --- The engine -----------------------------------------------------------------------

struct Request {
    host: String,
    port: u16,
    local: TcpStream,
    done: mpsc::Sender<Result<(), String>>,
}

struct Tunnel {
    config: WgConfig,
    requests: mpsc::Sender<Request>,
    alive: Arc<AtomicBool>,
    // The handshake with the server went through.
    up: Arc<AtomicBool>,
}

static TUNNEL: Mutex<Option<Arc<Tunnel>>> = Mutex::new(None);

fn tunnel(config: &WgConfig) -> std::io::Result<Arc<Tunnel>> {
    let mut current = TUNNEL.lock().unwrap();
    if let Some(t) = current.as_ref().filter(|t| t.config == *config && t.alive.load(Ordering::SeqCst)) {
        return Ok(t.clone());
    }
    if let Some(old) = current.take() {
        old.alive.store(false, Ordering::SeqCst);
    }
    let endpoint: SocketAddr = config.endpoint.to_socket_addrs()?.find(|a| a.is_ipv4()).ok_or_else(|| std::io::Error::other(format!("{} has no address", config.endpoint)))?;
    let udp = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))?;
    udp.connect(endpoint)?;
    udp.set_nonblocking(true)?;
    let (tx, rx) = mpsc::channel();
    let t = Arc::new(Tunnel { config: config.clone(), requests: tx, alive: Arc::new(AtomicBool::new(true)), up: Arc::new(AtomicBool::new(false)) });
    let (cfg, alive, up) = (config.clone(), t.alive.clone(), t.up.clone());
    std::thread::spawn(move || run(cfg, udp, rx, alive, up));
    *current = Some(t.clone());
    Ok(t)
}

// The VPN went off, or to another server: the tunnel ends.
pub(crate) fn stop() {
    if let Some(t) = TUNNEL.lock().unwrap().take() {
        t.alive.store(false, Ordering::SeqCst);
    }
}

// Whether the server answers the handshake (the VPN button checks before
// it turns on).
pub(crate) fn check(config: &WgConfig) -> std::io::Result<()> {
    let t = tunnel(config)?;
    let until = Instant::now() + Duration::from_secs(8);
    while Instant::now() < until {
        if t.up.load(Ordering::SeqCst) {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Err(std::io::Error::other(format!("the WireGuard server {} didn't answer (is the key right?)", config.endpoint)))
}

// A connection to host:port through the tunnel: the local end to use.
pub(crate) fn connect(config: &WgConfig, host: &str, port: u16) -> std::io::Result<TcpStream> {
    let t = tunnel(config)?;
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    let ours = TcpStream::connect(listener.local_addr()?)?;
    let (theirs, from) = listener.accept()?;
    if from != ours.local_addr()? {
        return Err(std::io::Error::other("a stranger connected"));
    }
    let (done, result) = mpsc::channel();
    t.requests.send(Request { host: host.to_string(), port, local: theirs, done }).map_err(|_| std::io::Error::other("the VPN's tunnel closed"))?;
    match result.recv_timeout(Duration::from_secs(25)) {
        Ok(Ok(())) => Ok(ours),
        Ok(Err(e)) => Err(std::io::Error::other(e)),
        Err(_) => Err(std::io::Error::other(format!("{host} didn't answer through the VPN"))),
    }
}

// The packets between smoltcp and WireGuard.
#[derive(Default)]
struct Packets {
    inbound: VecDeque<Vec<u8>>,
    outbound: VecDeque<Vec<u8>>,
}

struct Rx(Vec<u8>);
struct Tx<'a>(&'a mut VecDeque<Vec<u8>>);

impl RxToken for Rx {
    fn consume<R, F: FnOnce(&[u8]) -> R>(self, f: F) -> R {
        f(&self.0)
    }
}

impl TxToken for Tx<'_> {
    fn consume<R, F: FnOnce(&mut [u8]) -> R>(self, len: usize, f: F) -> R {
        let mut packet = vec![0u8; len];
        let r = f(&mut packet);
        self.0.push_back(packet);
        r
    }
}

const MTU: usize = 1420;

impl Device for Packets {
    type RxToken<'a> = Rx;
    type TxToken<'a> = Tx<'a>;
    fn receive(&mut self, _: smoltcp::time::Instant) -> Option<(Rx, Tx<'_>)> {
        let p = self.inbound.pop_front()?;
        Some((Rx(p), Tx(&mut self.outbound)))
    }
    fn transmit(&mut self, _: smoltcp::time::Instant) -> Option<Tx<'_>> {
        Some(Tx(&mut self.outbound))
    }
    fn capabilities(&self) -> DeviceCapabilities {
        let mut c = DeviceCapabilities::default();
        c.medium = Medium::Ip;
        c.max_transmission_unit = MTU;
        c
    }
}

enum Stage {
    // Its name, being looked up at the VPN's DNS.
    Resolving { socket: SocketHandle, question: Vec<u8>, sent: Instant, tries: u8 },
    Connecting { socket: SocketHandle },
    Open { socket: SocketHandle },
}

struct Conn {
    stage: Stage,
    host: String,
    port: u16,
    started: Instant,
    local: TcpStream,
    done: Option<mpsc::Sender<Result<(), String>>>,
    // From the page, waiting to go through the tunnel; and back.
    to_tunnel: Vec<u8>,
    to_local: Vec<u8>,
    local_closed: bool,
    finished: bool,
}

impl Conn {
    fn fail(&mut self, why: String) {
        if let Some(done) = self.done.take() {
            let _ = done.send(Err(why));
        }
        self.finished = true;
    }
}

fn tcp_socket() -> tcp::Socket<'static> {
    let mut s = tcp::Socket::new(tcp::SocketBuffer::new(vec![0; 512 * 1024]), tcp::SocketBuffer::new(vec![0; 512 * 1024]));
    s.set_nagle_enabled(false);
    s
}

fn ephemeral_port() -> u16 {
    49152 + rand::random::<u16>() % 16000
}

// The engine: until it's stopped, or no one has used it for a while.
fn run(cfg: WgConfig, udp: UdpSocket, requests: mpsc::Receiver<Request>, alive: Arc<AtomicBool>, up: Arc<AtomicBool>) {
    use boringtun::x25519::{PublicKey, StaticSecret};
    let Ok(mut tunn) = Tunn::new(StaticSecret::from(cfg.private_key), PublicKey::from(cfg.peer_public), cfg.preshared, Some(25), rand::random::<u32>() & 0x00ff_ffff, None) else { return };
    let mut packets = Packets::default();
    let now = smoltcp::time::Instant::now;
    let mut iface = Interface::new(IfaceConfig::new(HardwareAddress::Ip), &mut packets, now());
    let [a, b, c, d] = cfg.address.octets();
    // (A /0 address: everything is reachable straight down the tunnel.)
    iface.update_ip_addrs(|addrs| {
        let _ = addrs.push(IpCidr::new(IpAddress::v4(a, b, c, d), 0));
    });
    let mut sockets = SocketSet::new(vec![]);
    let mut conns: Vec<Conn> = Vec::new();
    let mut wire = vec![0u8; 65536];
    let mut out = vec![0u8; 65536];
    let mut chunk = vec![0u8; 64 * 1024];
    let mut last_use = Instant::now();
    // Hello to the server at once (the VPN button waits for its answer).
    if let TunnResult::WriteToNetwork(p) = tunn.format_handshake_initiation(&mut out, false) {
        let _ = udp.send(p);
    }
    while alive.load(Ordering::SeqCst) {
        let mut busy = false;
        // From the server.
        while let Ok(n) = udp.recv(&mut wire) {
            busy = true;
            let mut result = tunn.decapsulate(None, &wire[..n], &mut out);
            loop {
                match result {
                    TunnResult::WriteToNetwork(p) => {
                        let _ = udp.send(p);
                        result = tunn.decapsulate(None, &[], &mut out);
                    }
                    TunnResult::WriteToTunnelV4(p, _) | TunnResult::WriteToTunnelV6(p, _) => {
                        packets.inbound.push_back(p.to_vec());
                        break;
                    }
                    _ => break,
                }
            }
        }
        if tunn.time_since_last_handshake().is_some() {
            up.store(true, Ordering::SeqCst);
        }
        if let TunnResult::WriteToNetwork(p) = tunn.update_timers(&mut out) {
            let _ = udp.send(p);
        }
        // New connections.
        while let Ok(req) = requests.try_recv() {
            busy = true;
            last_use = Instant::now();
            let _ = req.local.set_nonblocking(true);
            let _ = req.local.set_nodelay(true);
            let stage = match req.host.parse::<IpAddr>() {
                Ok(IpAddr::V4(ip)) => {
                    let mut s = tcp_socket();
                    let [a, b, c, d] = ip.octets();
                    let _ = s.connect(iface.context(), (IpAddress::v4(a, b, c, d), req.port), ephemeral_port());
                    Stage::Connecting { socket: sockets.add(s) }
                }
                Ok(IpAddr::V6(_)) => {
                    let _ = req.done.send(Err("IPv6 addresses don't go through this VPN".into()));
                    continue;
                }
                Err(_) => {
                    let mut s = udp::Socket::new(udp::PacketBuffer::new(vec![udp::PacketMetadata::EMPTY; 4], vec![0; 4096]), udp::PacketBuffer::new(vec![udp::PacketMetadata::EMPTY; 4], vec![0; 4096]));
                    let _ = s.bind(ephemeral_port());
                    let question = crate::net::dns_query(rand::random(), &req.host, 1);
                    Stage::Resolving { socket: sockets.add(s), question, sent: Instant::now() - Duration::from_secs(10), tries: 0 }
                }
            };
            conns.push(Conn { stage, host: req.host, port: req.port, started: Instant::now(), local: req.local, done: Some(req.done), to_tunnel: Vec::new(), to_local: Vec::new(), local_closed: false, finished: false });
        }
        iface.poll(now(), &mut packets, &mut sockets);
        // Each connection along.
        for conn in conns.iter_mut() {
            match conn.stage {
                Stage::Resolving { socket, ref question, ref mut sent, ref mut tries } => {
                    let s = sockets.get_mut::<udp::Socket>(socket);
                    if let Ok((answer, _)) = s.recv() {
                        let ip = crate::net::dns_answers(answer).and_then(|(ips, _)| {
                            ips.into_iter().find_map(|ip| match ip {
                                IpAddr::V4(v4) => Some(v4),
                                _ => None,
                            })
                        });
                        sockets.remove(socket);
                        match ip {
                            Some(ip) => {
                                let mut t = tcp_socket();
                                let [a, b, c, d] = ip.octets();
                                let _ = t.connect(iface.context(), (IpAddress::v4(a, b, c, d), conn.port), ephemeral_port());
                                conn.stage = Stage::Connecting { socket: sockets.add(t) };
                            }
                            None => conn.fail(format!("{} wasn't found (VPN's DNS)", conn.host)),
                        }
                        busy = true;
                    } else if sent.elapsed() > Duration::from_secs(3) {
                        if *tries >= 3 {
                            sockets.remove(socket);
                            conn.fail(format!("the VPN's DNS didn't answer for {}", conn.host));
                        } else {
                            let server = cfg.dns[*tries as usize % cfg.dns.len()];
                            let [a, b, c, d] = server.octets();
                            let _ = s.send_slice(question, IpEndpoint::new(IpAddress::Ipv4(Ipv4Address::new(a, b, c, d)), 53));
                            *sent = Instant::now();
                            *tries += 1;
                            busy = true;
                        }
                    }
                }
                Stage::Connecting { socket } => {
                    let s = sockets.get_mut::<tcp::Socket>(socket);
                    if s.may_send() {
                        if let Some(done) = conn.done.take() {
                            let _ = done.send(Ok(()));
                        }
                        conn.stage = Stage::Open { socket };
                        busy = true;
                    } else if s.state() == tcp::State::Closed || conn.started.elapsed() > Duration::from_secs(20) {
                        sockets.remove(socket);
                        conn.fail(format!("{}:{} didn't answer through the VPN", conn.host, conn.port));
                    }
                }
                Stage::Open { socket } => {
                    let s = sockets.get_mut::<tcp::Socket>(socket);
                    // Page -> tunnel.
                    if conn.to_tunnel.is_empty() && !conn.local_closed && s.can_send() {
                        match conn.local.read(&mut chunk) {
                            Ok(0) => conn.local_closed = true,
                            Ok(n) => conn.to_tunnel.extend_from_slice(&chunk[..n]),
                            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                            Err(_) => conn.local_closed = true,
                        }
                    }
                    if !conn.to_tunnel.is_empty() && s.can_send() {
                        if let Ok(n) = s.send_slice(&conn.to_tunnel) {
                            conn.to_tunnel.drain(..n);
                            busy |= n > 0;
                        }
                    }
                    if conn.local_closed && conn.to_tunnel.is_empty() && s.may_send() {
                        s.close();
                    }
                    // Tunnel -> page.
                    if conn.to_local.is_empty() && s.can_recv() {
                        if let Ok(n) = s.recv_slice(&mut chunk) {
                            conn.to_local.extend_from_slice(&chunk[..n]);
                        }
                    }
                    if !conn.to_local.is_empty() {
                        match conn.local.write(&conn.to_local) {
                            Ok(n) => {
                                conn.to_local.drain(..n);
                                busy |= n > 0;
                            }
                            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                            Err(_) => {
                                s.abort();
                                conn.finished = true;
                            }
                        }
                    }
                    if conn.to_local.is_empty() && !s.may_recv() && !s.can_recv() {
                        let _ = conn.local.shutdown(std::net::Shutdown::Write);
                        if conn.local_closed || s.state() == tcp::State::Closed {
                            conn.finished = true;
                        }
                    }
                    if s.state() == tcp::State::Closed {
                        conn.finished = true;
                    }
                    if conn.finished {
                        sockets.remove(socket);
                    }
                }
            }
        }
        if conns.iter().any(|c| c.finished) {
            conns.retain(|c| !c.finished);
        }
        if !conns.is_empty() {
            last_use = Instant::now();
        }
        iface.poll(now(), &mut packets, &mut sockets);
        // To the server.
        while let Some(p) = packets.outbound.pop_front() {
            busy = true;
            if let TunnResult::WriteToNetwork(d) = tunn.encapsulate(&p, &mut out) {
                let _ = udp.send(d);
            }
        }
        // Unused for ten minutes: it ends (the next connection starts it again).
        if last_use.elapsed() > Duration::from_secs(600) {
            alive.store(false, Ordering::SeqCst);
        }
        if !busy {
            std::thread::sleep(Duration::from_millis(1));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_wireguard_config_file() {
        let conf = "[Interface]\n# a comment\nPrivateKey = qGmE8hyJWRHeyqCvAwMt1qHh5WoqSGGJ5fGZQ0eVqUI=\nAddress = 10.14.0.2/16, fd00::2/64\nDNS = 162.252.172.57, 149.154.159.92\n\n[Peer]\nPublicKey = l8EOWPyzt/njrb74CADY4VOhns/TbUN6KFTbytHcFQw=\nAllowedIPs = 0.0.0.0/0\nEndpoint = al-tia.prod.surfshark.com:51820\n";
        let c = parse_conf(conf).unwrap();
        assert_eq!(c.address, Ipv4Addr::new(10, 14, 0, 2));
        assert_eq!(c.dns, vec![Ipv4Addr::new(162, 252, 172, 57), Ipv4Addr::new(149, 154, 159, 92)]);
        assert_eq!(c.endpoint, "al-tia.prod.surfshark.com:51820");
        assert!(c.preshared.is_none());
        assert!(!format!("{c:?}").contains("qGmE"), "no key in logs");
        assert!(parse_conf("[Interface]\nAddress = 10.0.0.2/32\n").is_err());
    }

    // A WireGuard server of the test's own (boringtun and smoltcp again),
    // with an echo service at 10.99.0.1:7 and a DNS server that knows
    // echo.test: Kessel's engine reaches it by name through the tunnel.
    #[test]
    fn through_a_wireguard_tunnel() {
        use boringtun::x25519::{PublicKey, StaticSecret};
        let server_secret = [7u8; 32];
        let client_secret = [9u8; 32];
        let server_public = PublicKey::from(&StaticSecret::from(server_secret)).to_bytes();
        let client_public = PublicKey::from(&StaticSecret::from(client_secret)).to_bytes();
        let udp = UdpSocket::bind("127.0.0.1:0").unwrap();
        let endpoint = udp.local_addr().unwrap();
        udp.set_nonblocking(true).unwrap();
        std::thread::spawn(move || {
            let mut tunn = Tunn::new(StaticSecret::from(server_secret), PublicKey::from(client_public), None, None, 1, None).unwrap();
            let mut packets = Packets::default();
            let now = smoltcp::time::Instant::now;
            let mut iface = Interface::new(IfaceConfig::new(HardwareAddress::Ip), &mut packets, now());
            iface.update_ip_addrs(|a| {
                let _ = a.push(IpCidr::new(IpAddress::v4(10, 99, 0, 1), 0));
            });
            let mut sockets = SocketSet::new(vec![]);
            let mut echo = tcp_socket();
            echo.listen(7).unwrap();
            let echo = sockets.add(echo);
            let mut dns = udp::Socket::new(udp::PacketBuffer::new(vec![udp::PacketMetadata::EMPTY; 4], vec![0; 4096]), udp::PacketBuffer::new(vec![udp::PacketMetadata::EMPTY; 4], vec![0; 4096]));
            dns.bind(53).unwrap();
            let dns = sockets.add(dns);
            let (mut wire, mut out, mut buf) = (vec![0u8; 65536], vec![0u8; 65536], vec![0u8; 4096]);
            let mut peer = None;
            loop {
                while let Ok((n, from)) = udp.recv_from(&mut wire) {
                    peer = Some(from);
                    let mut r = tunn.decapsulate(Some(from.ip()), &wire[..n], &mut out);
                    loop {
                        match r {
                            TunnResult::WriteToNetwork(p) => {
                                let _ = udp.send_to(p, from);
                                r = tunn.decapsulate(None, &[], &mut out);
                            }
                            TunnResult::WriteToTunnelV4(p, _) => {
                                packets.inbound.push_back(p.to_vec());
                                break;
                            }
                            _ => break,
                        }
                    }
                }
                iface.poll(now(), &mut packets, &mut sockets);
                let s = sockets.get_mut::<udp::Socket>(dns);
                if let Ok((q, meta)) = s.recv() {
                    let mut a = q.to_vec();
                    a[2] = 0x81;
                    a[3] = 0x80;
                    a[7] = 1;
                    a.extend_from_slice(&[0xc0, 12, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 10, 99, 0, 1]);
                    let _ = s.send_slice(&a, meta.endpoint);
                }
                let s = sockets.get_mut::<tcp::Socket>(echo);
                if s.can_recv() {
                    let n = s.recv_slice(&mut buf).unwrap();
                    let _ = s.send_slice(&buf[..n]);
                }
                iface.poll(now(), &mut packets, &mut sockets);
                while let Some(p) = packets.outbound.pop_front() {
                    if let (TunnResult::WriteToNetwork(d), Some(to)) = (tunn.encapsulate(&p, &mut out), peer) {
                        let _ = udp.send_to(d, to);
                    }
                }
                std::thread::sleep(Duration::from_millis(1));
            }
        });
        let cfg = WgConfig { private_key: client_secret, peer_public: server_public, preshared: None, endpoint: endpoint.to_string(), address: Ipv4Addr::new(10, 99, 0, 2), dns: vec![Ipv4Addr::new(10, 99, 0, 1)] };
        check(&cfg).expect("the handshake");
        let mut s = connect(&cfg, "echo.test", 7).expect("through the tunnel, by name");
        let message = vec![b'k'; 200_000];
        let mut writer = s.try_clone().unwrap();
        let sent = message.clone();
        std::thread::spawn(move || writer.write_all(&sent).unwrap());
        let mut back = vec![0u8; message.len()];
        s.set_read_timeout(Some(Duration::from_secs(20))).unwrap();
        s.read_exact(&mut back).expect("echoed back");
        assert_eq!(back, message);
        stop();
    }
}
