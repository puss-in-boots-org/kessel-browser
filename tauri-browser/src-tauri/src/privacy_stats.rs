// What Shields did, over time, for the privacy dashboard (kessel://privacy):
// requests it blocked, connections it upgraded to HTTPS and tracking
// parameters it took out of addresses -- per hour (UTC; the page adds them
// up into your own days) for 90 days, and blocked requests per site. Kept
// in privacy_stats.json, written at most every 30 seconds.

use super::*;
use std::collections::BTreeMap;
use std::sync::atomic::AtomicBool;

const HOURS_KEPT: u64 = 90 * 24;
const SITES_KEPT: usize = 300;

#[derive(Default, Clone, Copy, serde::Serialize, serde::Deserialize)]
struct Counts {
    #[serde(default)]
    blocked: u64,
    #[serde(default)]
    upgraded: u64,
    #[serde(default)]
    stripped: u64,
}

#[derive(Default, serde::Serialize, serde::Deserialize)]
struct Stats {
    // When counting started (unix seconds).
    #[serde(default)]
    since: u64,
    // Unix hour (seconds / 3600) -> what happened in it.
    #[serde(default)]
    hours: BTreeMap<u64, Counts>,
    // Site (no www.) -> requests blocked on its pages.
    #[serde(default)]
    sites: HashMap<String, u64>,
}

static STATS: Mutex<Option<Stats>> = Mutex::new(None);
static DIRTY: AtomicBool = AtomicBool::new(false);
static FILE: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

pub(crate) fn start(app: &tauri::AppHandle) {
    let path = app.state::<BrowserState>().data_dir.join("privacy_stats.json");
    let stats = store::read_text_recovering(&path, |t| serde_json::from_str::<Stats>(t).is_ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| Stats { since: now_unix(), ..Default::default() });
    *STATS.lock().unwrap() = Some(stats);
    let _ = FILE.set(path);
    std::thread::spawn(|| loop {
        std::thread::sleep(Duration::from_secs(30));
        flush();
    });
}

fn with(f: impl FnOnce(&mut Stats, &mut Counts)) {
    let mut guard = STATS.lock().unwrap();
    let Some(stats) = guard.as_mut() else { return };
    let mut hour = stats.hours.get(&(now_unix() / 3600)).copied().unwrap_or_default();
    f(stats, &mut hour);
    stats.hours.insert(now_unix() / 3600, hour);
    DIRTY.store(true, Ordering::Relaxed);
}

// `n` requests blocked on a page of `host` (empty: not known).
pub(crate) fn note_blocked(host: &str, n: u64) {
    let site = host.trim().trim_start_matches("www.").to_ascii_lowercase();
    with(|stats, hour| {
        hour.blocked += n;
        if !site.is_empty() {
            *stats.sites.entry(site).or_default() += n;
        }
    });
}

// An address rewritten before it loaded: upgraded to HTTPS, and/or its
// tracking parameters taken out.
pub(crate) fn note_rewrite(upgraded: bool, stripped: bool) {
    with(|_, hour| {
        hour.upgraded += upgraded as u64;
        hour.stripped += stripped as u64;
    });
}

fn flush() {
    if !DIRTY.swap(false, Ordering::Relaxed) {
        return;
    }
    let Some(path) = FILE.get() else { return };
    let text = {
        let mut guard = STATS.lock().unwrap();
        let Some(stats) = guard.as_mut() else { return };
        let oldest = (now_unix() / 3600).saturating_sub(HOURS_KEPT);
        stats.hours.retain(|h, _| *h >= oldest);
        if stats.sites.len() > SITES_KEPT * 2 {
            let mut all: Vec<(String, u64)> = stats.sites.drain().collect();
            all.sort_by(|a, b| b.1.cmp(&a.1));
            all.truncate(SITES_KEPT);
            stats.sites = all.into_iter().collect();
        }
        serde_json::to_string(stats)
    };
    if let Ok(text) = text {
        let _ = store::write_atomic(path, &text);
    }
}

// The dashboard's numbers: since when, every hour kept as
// [hour, blocked, upgraded, stripped], and the 20 sites with the most
// blocked.
#[tauri::command]
pub(crate) fn privacy_stats(webview: Webview) -> Result<serde_json::Value, String> {
    require_internal_page(&webview)?;
    let guard = STATS.lock().unwrap();
    let Some(stats) = guard.as_ref() else { return Ok(serde_json::Value::Null) };
    let hours: Vec<[u64; 4]> = stats.hours.iter().map(|(h, c)| [*h, c.blocked, c.upgraded, c.stripped]).collect();
    let mut sites: Vec<(&String, &u64)> = stats.sites.iter().collect();
    sites.sort_by(|a, b| b.1.cmp(a.1).then(a.0.cmp(b.0)));
    sites.truncate(20);
    Ok(serde_json::json!({ "since": stats.since, "hours": hours, "sites": sites }))
}

// "Start counting again".
#[tauri::command]
pub(crate) fn reset_privacy_stats(webview: Webview) -> Result<(), String> {
    require_internal_page(&webview)?;
    *STATS.lock().unwrap() = Some(Stats { since: now_unix(), ..Default::default() });
    DIRTY.store(true, Ordering::Relaxed);
    flush();
    Ok(())
}
