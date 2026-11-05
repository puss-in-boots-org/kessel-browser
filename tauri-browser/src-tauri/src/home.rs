// What the Home page's corner (newtab.html) needs from Rust: the weather,
// the places you can pick for it, what your tabs are playing, and opening
// the music tab in the page's own window.
//
// The weather comes from Open-Meteo: no key, no account, and Kessel's own
// request (no cookies, no page involved). It only knows the place you typed
// in -- Kessel never guesses it from your IP address.

use crate::BrowserState;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::Webview;

const AGENT: &str = "Kessel (https://github.com/puss-in-boots-org/kessel-browser)";
// The weather changes slowly: one request per place every 15 minutes, however
// many Home tabs you open.
const FRESH: Duration = Duration::from_secs(15 * 60);

fn get_json(url: &str) -> Option<serde_json::Value> {
    use ureq::tls::{RootCerts, TlsConfig, TlsProvider};
    // Windows' own certificate store, like Shields' downloads (ESET and
    // other HTTPS-inspecting antivirus put their root there).
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .tls_config(TlsConfig::builder().provider(TlsProvider::NativeTls).root_certs(RootCerts::PlatformVerifier).build())
        .timeout_global(Some(Duration::from_secs(6)))
        .user_agent(AGENT)
        .build()
        .into();
    let text = agent.get(url).call().ok()?.body_mut().with_config().limit(512 * 1024).read_to_string().ok()?;
    serde_json::from_str(&text).ok()
}

fn valid_place(lat: f64, lon: f64) -> bool {
    lat.is_finite() && lon.is_finite() && lat.abs() <= 90.0 && lon.abs() <= 180.0
}

fn forecast_url(lat: f64, lon: f64, fahrenheit: bool) -> String {
    let (temp, wind) = if fahrenheit { ("fahrenheit", "mph") } else { ("celsius", "kmh") };
    format!(
        "https://api.open-meteo.com/v1/forecast?latitude={lat:.4}&longitude={lon:.4}\
         &current=temperature_2m,apparent_temperature,relative_humidity_2m,is_day,weather_code,wind_speed_10m,precipitation\
         &hourly=temperature_2m,weather_code,precipitation_probability,is_day\
         &daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset\
         &forecast_days=5&timezone=auto&temperature_unit={temp}&wind_speed_unit={wind}"
    )
}

static WEATHER: OnceLock<Mutex<HashMap<String, (Instant, serde_json::Value)>>> = OnceLock::new();

// Open-Meteo's forecast for a place, as it sends it (newtab.js reads it).
// Offline, the last one Kessel got for that place, with "stale": true.
#[tauri::command]
pub async fn home_weather(webview: Webview, state: tauri::State<'_, BrowserState>, lat: f64, lon: f64, fahrenheit: Option<bool>) -> Result<Option<serde_json::Value>, String> {
    crate::require_internal_page(&webview)?;
    if !valid_place(lat, lon) {
        return Err("That isn't a place on Earth".into());
    }
    let fahrenheit = fahrenheit.unwrap_or(false);
    let key = format!("{lat:.3},{lon:.3},{}", if fahrenheit { "F" } else { "C" });
    let cache = WEATHER.get_or_init(Default::default);
    if let Some((at, data)) = cache.lock().unwrap().get(&key) {
        if at.elapsed() < FRESH {
            return Ok(Some(data.clone()));
        }
    }
    let url = forecast_url(lat, lon, fahrenheit);
    let fetched = tauri::async_runtime::spawn_blocking(move || get_json(&url)).await.map_err(|e| e.to_string())?;
    let file = state.data_dir.join("weather.json");
    match fetched.filter(|v| v.get("current").is_some()) {
        Some(data) => {
            cache.lock().unwrap().insert(key.clone(), (Instant::now(), data.clone()));
            let saved = serde_json::json!({ "key": key, "data": data });
            let _ = std::fs::write(&file, saved.to_string());
            Ok(Some(data))
        }
        None => {
            let saved: Option<serde_json::Value> = std::fs::read_to_string(&file).ok().and_then(|s| serde_json::from_str(&s).ok());
            Ok(saved.filter(|s| s.get("key").and_then(|k| k.as_str()) == Some(key.as_str())).and_then(|s| s.get("data").cloned()).map(|mut data| {
                data["stale"] = serde_json::json!(true);
                data
            }))
        }
    }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Place {
    pub name: String,
    pub region: String,
    pub country: String,
    // "HU", "US"... (which unit the temperature starts in).
    pub code: String,
    pub lat: f64,
    pub lon: f64,
}

fn parse_places(data: &serde_json::Value) -> Vec<Place> {
    let text = |v: &serde_json::Value, key: &str| v.get(key).and_then(|x| x.as_str()).unwrap_or_default().to_string();
    data.get("results")
        .and_then(|r| r.as_array())
        .map(|list| {
            list.iter()
                .filter_map(|p| {
                    let (lat, lon) = (p.get("latitude")?.as_f64()?, p.get("longitude")?.as_f64()?);
                    let name = text(p, "name");
                    (valid_place(lat, lon) && !name.is_empty()).then(|| Place { name, region: text(p, "admin1"), country: text(p, "country"), code: text(p, "country_code"), lat, lon })
                })
                .collect()
        })
        .unwrap_or_default()
}

// Towns and cities matching what you typed into the weather card.
#[tauri::command]
pub async fn home_places(webview: Webview, query: String, language: Option<String>) -> Result<Vec<Place>, String> {
    crate::require_internal_page(&webview)?;
    let query = query.trim().to_string();
    if query.chars().count() < 2 {
        return Ok(Vec::new());
    }
    let language = language.filter(|l| l.len() == 2 && l.chars().all(|c| c.is_ascii_alphabetic())).unwrap_or_else(|| "en".into());
    let mut url = tauri::Url::parse("https://geocoding-api.open-meteo.com/v1/search").map_err(|e| e.to_string())?;
    url.query_pairs_mut().append_pair("name", &query).append_pair("count", "6").append_pair("format", "json").append_pair("language", &language);
    let data = tauri::async_runtime::spawn_blocking(move || get_json(url.as_str()))
        .await
        .map_err(|e| e.to_string())?
        .ok_or("Couldn't reach the weather service")?;
    Ok(parse_places(&data))
}

// Where this Home is: { private } -- a private window's Home leaves out
// your history and notes.
#[tauri::command]
pub fn home_context(webview: Webview, state: tauri::State<BrowserState>) -> Result<serde_json::Value, String> {
    crate::require_internal_page(&webview)?;
    let private = state.window_of(&webview).map(|w| state.is_private(&w)).unwrap_or(false);
    Ok(serde_json::json!({ "private": private }))
}

// --- Music ---------------------------------------------------------------------------

// Tabs that have played sound, the latest first; and which of them play
// right now. Told by main.rs's IsDocumentPlayingAudioChanged handler.
static PLAYED: Mutex<Vec<(u32, bool)>> = Mutex::new(Vec::new());

pub(crate) fn note_audio(id: u32, playing: bool) {
    let mut list = PLAYED.lock().unwrap();
    if let Some(entry) = list.iter_mut().find(|(x, _)| *x == id) {
        entry.1 = playing;
    } else if playing {
        list.insert(0, (id, true));
    }
    // Whichever started last goes first.
    if playing {
        if let Some(at) = list.iter().position(|(x, _)| *x == id) {
            let entry = list.remove(at);
            list.insert(0, entry);
        }
    }
    list.truncate(16);
}

// The tabs that have played sound, latest first (only from windows as
// private as the caller's: a normal window's Home never shows what a
// private window plays, or the other way round).
#[tauri::command]
pub fn home_played(webview: Webview, state: tauri::State<BrowserState>) -> Result<Vec<serde_json::Value>, String> {
    crate::require_internal_page(&webview)?;
    let caller_private = state.window_of(&webview).map(|w| state.is_private(&w)).unwrap_or(false);
    let list = PLAYED.lock().unwrap().clone();
    let private = state.private_tabs.lock().unwrap().clone();
    Ok(list
        .into_iter()
        .filter(|(id, _)| private.contains(id) == caller_private)
        .filter_map(|(id, playing)| {
            let mut info = crate::tab_info(&state, id)?;
            info["playing"] = serde_json::json!(playing);
            Some(info)
        })
        .take(4)
        .collect())
}

// The music card's services open in the window's music tab -- the toolbar
// finds it (or makes it) and shows it (see "home-music" in main.js).
// `tab`: a tab to switch to instead (now playing).
#[tauri::command]
pub fn home_music(app: tauri::AppHandle, webview: Webview, state: tauri::State<BrowserState>, url: Option<String>, tab: Option<u32>) -> Result<(), String> {
    crate::require_internal_page(&webview)?;
    if let Some(url) = &url {
        let parsed = tauri::Url::parse(url).map_err(|_| "That isn't a link")?;
        if parsed.scheme() != "https" {
            return Err("Music services open over https only".into());
        }
    }
    // A playing tab may be in another window: that window shows it.
    let win = match tab {
        Some(id) => state.tab_window(id),
        None => state.window_of(&webview),
    }
    .ok_or("This page isn't in a browser window")?;
    if tab.is_some() && state.window_of(&webview).as_deref() != Some(win.as_str()) {
        if let Some(window) = state.window_handle(&win) {
            let _ = window.set_focus();
        }
    }
    crate::emit_to_window(&app, &win, "home-music", serde_json::json!({ "url": url, "tab": tab }));
    Ok(())
}

// --- Free games and deals ------------------------------------------------------------

// A game on the games card: free for a while (GamerPower's giveaways on
// Epic, Steam and GOG) or cheaper (CheapShark's best-rated Steam deals).
#[derive(Serialize, serde::Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(default)]
pub struct Game {
    pub title: String,
    pub image: String,
    pub url: String,
    pub store: String,
    // What it usually costs ("$19.99"), and now ("Free", "$4.99").
    pub worth: String,
    pub price: String,
    // Percent off.
    pub cut: u32,
    // Free until (a date, "2026-11-12"), if the store says.
    pub until: String,
}

#[derive(Serialize, serde::Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Games {
    pub free: Vec<Game>,
    pub deals: Vec<Game>,
    pub fetched_at: u64,
    pub stale: bool,
}

const FREE_GAMES_URL: &str = "https://www.gamerpower.com/api/filter?platform=epic-games-store.steam.gog&type=game";
const DEALS_URL: &str = "https://www.cheapshark.com/api/1.0/deals?storeID=1&onSale=1&AAA=1&sortBy=Deal%20Rating&pageSize=12";
const GAMES_FRESH_SECS: u64 = 3 * 3600;

fn https(url: &str) -> bool {
    tauri::Url::parse(url).map(|u| u.scheme() == "https").unwrap_or(false)
}

fn parse_free_games(data: &serde_json::Value) -> Vec<Game> {
    let text = |v: &serde_json::Value, key: &str| v.get(key).and_then(|x| x.as_str()).unwrap_or_default().trim().to_string();
    // No giveaways answers with an object ({ status: 0, ... }), not a list.
    let Some(list) = data.as_array() else { return Vec::new() };
    list.iter()
        .filter(|g| text(g, "status").eq_ignore_ascii_case("active") || text(g, "status").is_empty())
        .filter_map(|g| {
            let (title, url, image) = (text(g, "title"), text(g, "open_giveaway_url"), text(g, "thumbnail"));
            if title.is_empty() || !https(&url) {
                return None;
            }
            let platforms = text(g, "platforms").to_lowercase();
            let store = if platforms.contains("epic") {
                "Epic"
            } else if platforms.contains("steam") {
                "Steam"
            } else if platforms.contains("gog") {
                "GOG"
            } else {
                "PC"
            };
            // "Cyberpunk 2077 (Epic Games) Giveaway" -> "Cyberpunk 2077".
            let mut title = title.trim_end_matches(" Giveaway").trim().to_string();
            if let Some(at) = title.rfind(" (") {
                if title.ends_with(')') {
                    title.truncate(at);
                }
            }
            let worth = text(g, "worth");
            let until = text(g, "end_date");
            Some(Game {
                title,
                image: if https(&image) { image } else { String::new() },
                url,
                store: store.into(),
                worth: if worth.eq_ignore_ascii_case("n/a") { String::new() } else { worth },
                price: "Free".into(),
                cut: 100,
                until: if until.len() >= 10 && until.as_bytes()[4] == b'-' { until[..10].to_string() } else { String::new() },
            })
        })
        .take(8)
        .collect()
}

fn parse_deals(data: &serde_json::Value) -> Vec<Game> {
    let text = |v: &serde_json::Value, key: &str| v.get(key).and_then(|x| x.as_str()).unwrap_or_default().trim().to_string();
    let Some(list) = data.as_array() else { return Vec::new() };
    let mut seen = std::collections::HashSet::new();
    list.iter()
        .filter_map(|d| {
            let (title, app) = (text(d, "title"), text(d, "steamAppID"));
            // Straight to the store page -- only Steam deals have one.
            if title.is_empty() || app.is_empty() || !app.chars().all(|c| c.is_ascii_digit()) || !seen.insert(app.clone()) {
                return None;
            }
            let sale: f64 = text(d, "salePrice").parse().ok()?;
            let normal: f64 = text(d, "normalPrice").parse().ok()?;
            let cut = text(d, "savings").parse::<f64>().ok().map(|s| s.round().clamp(0.0, 100.0) as u32).unwrap_or(0);
            if cut < 10 {
                return None;
            }
            Some(Game {
                title,
                image: format!("https://cdn.cloudflare.steamstatic.com/steam/apps/{app}/header.jpg"),
                url: format!("https://store.steampowered.com/app/{app}/"),
                store: "Steam".into(),
                worth: format!("${normal:.2}"),
                price: if sale <= 0.0 { "Free".into() } else { format!("${sale:.2}") },
                cut,
                until: String::new(),
            })
        })
        .take(8)
        .collect()
}

// This week's free games and the best deals; fetched at most every three
// hours, the last ones offline (with "stale": true).
#[tauri::command]
pub async fn home_games(webview: Webview, state: tauri::State<'_, BrowserState>) -> Result<Option<Games>, String> {
    crate::require_internal_page(&webview)?;
    let file = state.data_dir.join("games.json");
    let cached: Option<Games> = std::fs::read_to_string(&file).ok().and_then(|s| serde_json::from_str(&s).ok());
    let now = crate::store::now_unix();
    if let Some(c) = cached.as_ref().filter(|c| now.saturating_sub(c.fetched_at) < GAMES_FRESH_SECS) {
        return Ok(Some(c.clone()));
    }
    let fetched = tauri::async_runtime::spawn_blocking(|| {
        let free = get_json(FREE_GAMES_URL).map(|d| parse_free_games(&d));
        let deals = get_json(DEALS_URL).map(|d| parse_deals(&d));
        (free, deals)
    })
    .await
    .map_err(|e| e.to_string())?;
    match fetched {
        (None, None) => Ok(cached.map(|mut c| {
            c.stale = true;
            c
        })),
        (free, deals) => {
            let games = Games {
                free: free.or_else(|| cached.as_ref().map(|c| c.free.clone())).unwrap_or_default(),
                deals: deals.or_else(|| cached.as_ref().map(|c| c.deals.clone())).unwrap_or_default(),
                fetched_at: now,
                stale: false,
            };
            if let Ok(text) = serde_json::to_string(&games) {
                let _ = std::fs::write(&file, text);
            }
            Ok(Some(games))
        }
    }
}

// --- What other apps play (Windows' media controls) --------------------------------------

// The Spotify app, Apple Music, a video in another browser -- whatever
// shows in Windows' own media flyout -- except Kessel itself, whose tabs the
// music card already lists.
#[derive(Serialize, Default, Debug)]
pub struct SystemMedia {
    pub app: String,
    pub title: String,
    pub artist: String,
    pub playing: bool,
    pub can_toggle: bool,
    pub can_prev: bool,
    pub can_next: bool,
    // Which song this is, so the page can ask for its picture only once.
    pub key: String,
    // The album art as a data: URL, unless the page already has this key's.
    pub art: Option<String>,
}

pub(crate) fn media_app_name(aumid: &str) -> String {
    let low = aumid.to_lowercase();
    let known = [
        ("spotify", "Spotify"),
        ("applemusic", "Apple Music"),
        ("appleinc.", "Apple Music"),
        ("itunes", "iTunes"),
        ("zunemusic", "Media Player"),
        ("zunevideo", "Media Player"),
        ("tidal", "TIDAL"),
        ("deezer", "Deezer"),
        ("chrome", "Chrome"),
        ("msedge", "Edge"),
        ("firefox", "Firefox"),
        ("opera", "Opera"),
        ("brave", "Brave"),
        ("vlc", "VLC"),
    ];
    if let Some((_, name)) = known.iter().find(|(k, _)| low.contains(k)) {
        return (*name).into();
    }
    // "C:\...\foobar2000.exe" or "Vendor.App_xyz!App" -> "foobar2000" / "App".
    let stem = aumid.rsplit(['\\', '/', '!']).next().unwrap_or(aumid);
    let stem = stem.strip_suffix(".exe").or_else(|| stem.strip_suffix(".EXE")).unwrap_or(stem);
    let mut chars = stem.chars();
    chars.next().map(|c| c.to_uppercase().chain(chars).collect()).unwrap_or_default()
}

fn is_kessel_session(aumid: &str) -> bool {
    let low = aumid.to_lowercase();
    low.contains("kessel") || low.contains("msedgewebview2")
}

#[cfg(windows)]
mod system_media {
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSession as Session, GlobalSystemMediaTransportControlsSessionManager as Manager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
    };

    pub(super) fn com() {
        use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
    }

    fn aumid(s: &Session) -> String {
        s.SourceAppUserModelId().map(|h| h.to_string()).unwrap_or_default()
    }

    fn playing(s: &Session) -> bool {
        s.GetPlaybackInfo().and_then(|p| p.PlaybackStatus()).map(|st| st == Status::Playing).unwrap_or(false)
    }

    // Windows' "current" session, else one that plays, else any -- never Kessel's.
    pub(super) fn session() -> windows::core::Result<Option<Session>> {
        let manager = Manager::RequestAsync()?.get()?;
        if let Ok(current) = manager.GetCurrentSession() {
            if !super::is_kessel_session(&aumid(&current)) {
                return Ok(Some(current));
            }
        }
        let mut any = None;
        for s in manager.GetSessions()? {
            if super::is_kessel_session(&aumid(&s)) {
                continue;
            }
            if playing(&s) {
                return Ok(Some(s));
            }
            any.get_or_insert(s);
        }
        Ok(any)
    }

    fn art(s: &windows::Media::Control::GlobalSystemMediaTransportControlsSessionMediaProperties) -> Option<String> {
        use base64::Engine;
        use windows::Storage::Streams::DataReader;
        let stream = s.Thumbnail().ok()?.OpenReadAsync().ok()?.get().ok()?;
        let size = stream.Size().ok()?;
        if size == 0 || size > 3 * 1024 * 1024 {
            return None;
        }
        let kind = stream.ContentType().map(|h| h.to_string()).unwrap_or_default();
        let kind = if kind.starts_with("image/") { kind } else { "image/png".into() };
        let reader = DataReader::CreateDataReader(&stream.GetInputStreamAt(0).ok()?).ok()?;
        reader.LoadAsync(size as u32).ok()?.get().ok()?;
        let mut bytes = vec![0u8; size as usize];
        reader.ReadBytes(&mut bytes).ok()?;
        Some(format!("data:{kind};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
    }

    pub(super) fn read(art_for: Option<String>) -> Option<super::SystemMedia> {
        com();
        let s = session().ok()??;
        let app = super::media_app_name(&aumid(&s));
        let props = s.TryGetMediaPropertiesAsync().ok()?.get().ok()?;
        let title = props.Title().map(|h| h.to_string()).unwrap_or_default();
        if title.is_empty() {
            return None;
        }
        let artist = props.Artist().map(|h| h.to_string()).unwrap_or_default();
        let info = s.GetPlaybackInfo().ok()?;
        let controls = info.Controls().ok()?;
        let key = format!("{app}\u{1f}{title}\u{1f}{artist}");
        let art = if art_for.as_deref() == Some(key.as_str()) { None } else { art(&props) };
        Some(super::SystemMedia {
            app,
            title,
            artist,
            playing: info.PlaybackStatus().map(|st| st == Status::Playing).unwrap_or(false),
            can_toggle: controls.IsPlayPauseToggleEnabled().unwrap_or(false),
            can_prev: controls.IsPreviousEnabled().unwrap_or(false),
            can_next: controls.IsNextEnabled().unwrap_or(false),
            key,
            art,
        })
    }

    pub(super) fn act(action: &str) -> Result<(), String> {
        com();
        let s = session().map_err(|e| e.to_string())?.ok_or("Nothing is playing")?;
        let done = match action {
            "toggle" => s.TryTogglePlayPauseAsync(),
            "next" => s.TrySkipNextAsync(),
            "previous" => s.TrySkipPreviousAsync(),
            _ => return Err("Unknown media action".into()),
        }
        .and_then(|op| op.get())
        .map_err(|e| e.to_string())?;
        if done {
            Ok(())
        } else {
            Err("That app didn't take it".into())
        }
    }
}

// What another app plays now, if anything. `art_for`: the key of the song
// whose picture the page already has.
#[tauri::command]
pub async fn home_system_media(webview: Webview, art_for: Option<String>) -> Result<Option<SystemMedia>, String> {
    crate::require_internal_page(&webview)?;
    #[cfg(windows)]
    return tauri::async_runtime::spawn_blocking(move || system_media::read(art_for)).await.map_err(|e| e.to_string());
    #[cfg(not(windows))]
    {
        let _ = art_for;
        Ok(None)
    }
}

// Play/pause ("toggle"), "next" or "previous" in that app.
#[tauri::command]
pub async fn home_system_media_action(webview: Webview, action: String) -> Result<(), String> {
    crate::require_internal_page(&webview)?;
    #[cfg(windows)]
    return tauri::async_runtime::spawn_blocking(move || system_media::act(&action)).await.map_err(|e| e.to_string())?;
    #[cfg(not(windows))]
    {
        let _ = action;
        Err("Only on Windows".into())
    }
}

// --- PC and Kessel stats ----------------------------------------------------------------

// (idle, total) CPU time when last asked, in 100 ns units.
static SYSTEM_CPU: Mutex<Option<(u64, u64)>> = Mutex::new(None);

// How busy the CPU was since the last ask, in percent (None the first time).
#[cfg(windows)]
fn system_cpu() -> Option<f64> {
    use windows::Win32::Foundation::FILETIME;
    use windows::Win32::System::Threading::GetSystemTimes;
    let (mut idle, mut kernel, mut user) = (FILETIME::default(), FILETIME::default(), FILETIME::default());
    unsafe { GetSystemTimes(Some(&mut idle as *mut _), Some(&mut kernel as *mut _), Some(&mut user as *mut _)) }.ok()?;
    let ticks = |t: FILETIME| ((t.dwHighDateTime as u64) << 32) | t.dwLowDateTime as u64;
    // Kernel time includes the idle time.
    let (idle, total) = (ticks(idle), ticks(kernel) + ticks(user));
    let previous = SYSTEM_CPU.lock().unwrap().replace((idle, total));
    let (idle_before, total_before) = previous?;
    let spent = total.saturating_sub(total_before);
    if spent == 0 {
        return None;
    }
    Some((100.0 - idle.saturating_sub(idle_before) as f64 / spent as f64 * 100.0).clamp(0.0, 100.0))
}

// The stats card: { cpu (%), memory: { total, available, load }, kessel:
// { memory (bytes), cpu (%), processes } } -- Kessel being its own process
// and every one its engines run.
#[tauri::command]
pub async fn home_stats(app: tauri::AppHandle, webview: Webview) -> Result<serde_json::Value, String> {
    crate::require_internal_page(&webview)?;
    #[cfg(windows)]
    {
        use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
        let mut pids = crate::tasks::engine_pids(&app).await;
        pids.push(std::process::id());
        pids.sort_unstable();
        pids.dedup();
        let (kessel_memory, kessel_cpu, count) = tauri::async_runtime::spawn_blocking(move || {
            let mut memory = 0u64;
            let mut cpu: Option<f64> = None;
            let mut count = 0;
            for pid in pids {
                if let Some((m, c)) = crate::lifecycle::process_usage(pid) {
                    memory += m;
                    count += 1;
                    if let Some(c) = c {
                        cpu = Some(cpu.unwrap_or(0.0) + c);
                    }
                }
            }
            (memory, cpu, count)
        })
        .await
        .map_err(|e| e.to_string())?;
        let mut status = MEMORYSTATUSEX { dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32, ..Default::default() };
        let memory = if unsafe { GlobalMemoryStatusEx(&mut status) }.is_ok() {
            serde_json::json!({ "total": status.ullTotalPhys, "available": status.ullAvailPhys, "load": status.dwMemoryLoad })
        } else {
            serde_json::Value::Null
        };
        return Ok(serde_json::json!({
            "cpu": system_cpu(),
            "memory": memory,
            "kessel": { "memory": kessel_memory, "cpu": kessel_cpu.map(|c| c.min(100.0)), "processes": count },
        }));
    }
    #[allow(unreachable_code)]
    {
        let _ = app;
        Ok(serde_json::Value::Null)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn free_games_from_gamerpower() {
        let data = serde_json::json!([
            { "title": "Hades (Epic Games) Giveaway", "worth": "$24.99", "thumbnail": "https://www.gamerpower.com/offers/1/hades.jpg",
              "open_giveaway_url": "https://www.gamerpower.com/open/hades", "platforms": "PC, Epic Games Store", "end_date": "2026-11-12 23:59:00", "status": "Active" },
            { "title": "Old one", "open_giveaway_url": "https://x.example/", "platforms": "Steam", "status": "Expired" },
            { "title": "No link", "open_giveaway_url": "javascript:alert(1)", "platforms": "GOG", "status": "Active" },
            { "title": "Forever free", "worth": "N/A", "thumbnail": "http://insecure/img.jpg", "open_giveaway_url": "https://www.gamerpower.com/open/f", "platforms": "PC, GOG", "end_date": "N/A", "status": "Active" }
        ]);
        let games = parse_free_games(&data);
        assert_eq!(games.len(), 2);
        assert_eq!(games[0].title, "Hades");
        assert_eq!(games[0].store, "Epic");
        assert_eq!(games[0].until, "2026-11-12");
        assert_eq!(games[0].worth, "$24.99");
        assert_eq!(games[1].store, "GOG");
        assert_eq!(games[1].worth, "");
        assert_eq!(games[1].until, "");
        assert_eq!(games[1].image, "", "only https pictures");
        // No giveaways: an object, not a list.
        assert!(parse_free_games(&serde_json::json!({ "status": 0 })).is_empty());
    }

    #[test]
    fn deals_from_cheapshark() {
        let data = serde_json::json!([
            { "title": "Portal 2", "steamAppID": "620", "salePrice": "1.99", "normalPrice": "9.99", "savings": "80.08" },
            { "title": "Portal 2 again", "steamAppID": "620", "salePrice": "1.99", "normalPrice": "9.99", "savings": "80.08" },
            { "title": "Not on Steam", "steamAppID": null, "salePrice": "1.00", "normalPrice": "5.00", "savings": "80" },
            { "title": "Barely off", "steamAppID": "1", "salePrice": "9.50", "normalPrice": "9.99", "savings": "4.9" }
        ]);
        let deals = parse_deals(&data);
        assert_eq!(deals.len(), 1);
        assert_eq!(deals[0].url, "https://store.steampowered.com/app/620/");
        assert_eq!(deals[0].price, "$1.99");
        assert_eq!(deals[0].worth, "$9.99");
        assert_eq!(deals[0].cut, 80);
    }

    #[test]
    fn media_app_names() {
        assert_eq!(media_app_name("Spotify.exe"), "Spotify");
        assert_eq!(media_app_name("SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify"), "Spotify");
        assert_eq!(media_app_name("AppleInc.AppleMusicWin_nzyj5cx40ttqa!App"), "Apple Music");
        assert_eq!(media_app_name("C:\\Program Files\\foobar2000\\foobar2000.exe"), "Foobar2000");
        assert!(is_kessel_session("com.example.kessel"));
        assert!(is_kessel_session("C:\\x\\Kessel.exe"));
        assert!(!is_kessel_session("Spotify.exe"));
    }

    #[test]
    fn places_keep_only_real_ones() {
        let data = serde_json::json!({ "results": [
            { "name": "Budapest", "admin1": "Budapest", "country": "Hungary", "country_code": "HU", "latitude": 47.498, "longitude": 19.04 },
            { "name": "", "latitude": 1.0, "longitude": 1.0 },
            { "name": "Nowhere", "latitude": 123.0, "longitude": 1.0 },
            { "name": "No coords" }
        ]});
        let places = parse_places(&data);
        assert_eq!(places.len(), 1);
        assert_eq!(places[0].name, "Budapest");
        assert_eq!(places[0].country, "Hungary");
        assert_eq!(places[0].code, "HU");
        assert!(parse_places(&serde_json::json!({})).is_empty());
    }

    #[test]
    fn forecast_asks_for_the_right_units() {
        assert!(forecast_url(47.5, 19.04, false).contains("temperature_unit=celsius&wind_speed_unit=kmh"));
        assert!(forecast_url(47.5, 19.04, true).contains("temperature_unit=fahrenheit&wind_speed_unit=mph"));
        assert!(forecast_url(47.5, 19.04, false).contains("latitude=47.5000&longitude=19.0400"));
    }

    #[test]
    fn played_tabs_latest_first() {
        PLAYED.lock().unwrap().clear();
        note_audio(1, true);
        note_audio(2, true);
        note_audio(1, false);
        note_audio(3, false); // never played: not listed
        assert_eq!(*PLAYED.lock().unwrap(), vec![(2, true), (1, false)]);
        note_audio(1, true);
        assert_eq!(*PLAYED.lock().unwrap(), vec![(1, true), (2, true)]);
    }
}
