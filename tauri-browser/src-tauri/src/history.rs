// Browsing history, in SQLite (history.sqlite in the profile folder): every
// visit with its time, address, title and site, kept as long as Settings ->
// Privacy -> "Keep history" says (90 days by default, like Chrome).
//
// Kessel used to keep only its last 500 visits, in history.json, rewritten
// whole on every change; that file is imported once and renamed.

use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Mutex;

#[derive(Serialize, Clone, Debug)]
pub struct Visit {
    pub id: i64,
    pub url: String,
    pub title: String,
    pub host: String,
    pub visited_at: u64,
}

// A site in the "by site" view: how often and how recently you went there.
#[derive(Serialize, Clone, Debug)]
pub struct SiteVisits {
    pub host: String,
    pub visits: u64,
    pub last_visit: u64,
    pub title: String,
    pub url: String,
}

pub struct History {
    conn: Mutex<Connection>,
}

// The site part of an address, without "www." (so www.youtube.com and
// youtube.com are one site).
pub fn site_of(url: &str) -> String {
    tauri::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.trim_start_matches("www.").to_lowercase()))
        .unwrap_or_default()
}

// For LIKE: % and _ in what you typed are literal.
fn like_pattern(text: &str) -> String {
    let escaped = text.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
    format!("%{}%", escaped)
}

#[derive(Deserialize)]
struct OldEntry {
    url: String,
    #[serde(default)]
    title: String,
    visited_at: u64,
}

impl History {
    pub fn open(dir: &Path) -> Self {
        let conn = Connection::open(dir.join("history.sqlite"))
            .or_else(|_| Connection::open_in_memory())
            .expect("couldn't open any history database");
        let _ = conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             CREATE TABLE IF NOT EXISTS visits (
                 id INTEGER PRIMARY KEY,
                 url TEXT NOT NULL,
                 title TEXT NOT NULL DEFAULT '',
                 host TEXT NOT NULL DEFAULT '',
                 visited_at INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS visits_time ON visits(visited_at);
             CREATE INDEX IF NOT EXISTS visits_url ON visits(url);
             CREATE INDEX IF NOT EXISTS visits_host ON visits(host);",
        );
        let history = History { conn: Mutex::new(conn) };
        history.import_json(&dir.join("history.json"));
        history
    }

    // The old history.json, once.
    fn import_json(&self, path: &Path) {
        let Ok(text) = std::fs::read_to_string(path) else { return };
        let entries: Vec<OldEntry> = serde_json::from_str(&text).unwrap_or_default();
        {
            let mut conn = self.conn.lock().unwrap();
            let Ok(tx) = conn.transaction() else { return };
            for e in entries {
                let _ = tx.execute(
                    "INSERT INTO visits (url, title, host, visited_at) VALUES (?1, ?2, ?3, ?4)",
                    params![e.url, e.title, site_of(&e.url), e.visited_at as i64],
                );
            }
            if tx.commit().is_err() {
                return;
            }
        }
        let _ = std::fs::rename(path, path.with_extension("json.imported"));
    }

    // A visit, now. Going to the page you're already on again (a reload,
    // clicking the same link twice) refreshes its entry instead of adding
    // another.
    pub fn record(&self, url: &str, title: &str, now: u64) {
        let conn = self.conn.lock().unwrap();
        let last: Option<(i64, String)> = conn
            .query_row("SELECT id, url FROM visits ORDER BY visited_at DESC, id DESC LIMIT 1", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()
            .ok()
            .flatten();
        match last {
            Some((id, last_url)) if last_url == url => {
                let _ = conn.execute("UPDATE visits SET visited_at = ?1 WHERE id = ?2", params![now as i64, id]);
            }
            _ => {
                let _ = conn.execute(
                    "INSERT INTO visits (url, title, host, visited_at) VALUES (?1, ?2, ?3, ?4)",
                    params![url, title, site_of(url), now as i64],
                );
            }
        }
    }

    // A visit is recorded as the page starts loading, before it has a
    // title; this fills the title in once it has one.
    pub fn set_title(&self, url: &str, title: &str) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "UPDATE visits SET title = ?1 WHERE id = (SELECT id FROM visits WHERE url = ?2 ORDER BY visited_at DESC, id DESC LIMIT 1)",
            params![title, url],
        );
    }

    // Visits, newest first: matching `text` (in the title or address), in
    // [from, to) (unix seconds), on `site`.
    pub fn query(&self, text: &str, from: Option<u64>, to: Option<u64>, site: Option<&str>, limit: u32, offset: u32) -> Vec<Visit> {
        let mut sql = String::from("SELECT id, url, title, host, visited_at FROM visits WHERE 1 = 1");
        let mut args: Vec<rusqlite::types::Value> = Vec::new();
        let text = text.trim();
        if !text.is_empty() {
            // Every word must appear, in the title or the address.
            for word in text.split_whitespace().take(8) {
                sql.push_str(" AND (title LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\')");
                args.push(like_pattern(word).into());
                args.push(like_pattern(word).into());
            }
        }
        if let Some(from) = from {
            sql.push_str(" AND visited_at >= ?");
            args.push((from as i64).into());
        }
        if let Some(to) = to {
            sql.push_str(" AND visited_at < ?");
            args.push((to as i64).into());
        }
        if let Some(site) = site.filter(|s| !s.is_empty()) {
            sql.push_str(" AND host = ?");
            args.push(site.trim_start_matches("www.").to_lowercase().into());
        }
        sql.push_str(" ORDER BY visited_at DESC, id DESC LIMIT ? OFFSET ?");
        args.push((limit.min(5_000) as i64).into());
        args.push((offset as i64).into());
        let conn = self.conn.lock().unwrap();
        let Ok(mut stmt) = conn.prepare(&sql) else { return Vec::new() };
        stmt.query_map(params_from_iter(args), |r| {
            Ok(Visit { id: r.get(0)?, url: r.get(1)?, title: r.get(2)?, host: r.get(3)?, visited_at: r.get::<_, i64>(4)? as u64 })
        })
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default()
    }

    // Sites you've visited, most visited first (the "by site" view).
    pub fn sites(&self, text: &str, limit: u32) -> Vec<SiteVisits> {
        let conn = self.conn.lock().unwrap();
        let pattern = like_pattern(text.trim());
        let Ok(mut stmt) = conn.prepare(
            "SELECT host, COUNT(*), MAX(visited_at),
                    (SELECT title FROM visits v2 WHERE v2.host = v.host ORDER BY visited_at DESC LIMIT 1),
                    (SELECT url FROM visits v3 WHERE v3.host = v.host ORDER BY visited_at DESC LIMIT 1)
             FROM visits v WHERE host != '' AND host LIKE ?1 ESCAPE '\\'
             GROUP BY host ORDER BY COUNT(*) DESC, MAX(visited_at) DESC LIMIT ?2",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![pattern, limit.min(2_000) as i64], |r| {
            Ok(SiteVisits {
                host: r.get(0)?,
                visits: r.get::<_, i64>(1)? as u64,
                last_visit: r.get::<_, i64>(2)? as u64,
                title: r.get::<_, Option<String>>(3)?.unwrap_or_default(),
                url: r.get::<_, Option<String>>(4)?.unwrap_or_default(),
            })
        })
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default()
    }

    pub fn delete(&self, ids: &[i64]) -> usize {
        let conn = self.conn.lock().unwrap();
        ids.iter().map(|id| conn.execute("DELETE FROM visits WHERE id = ?1", params![id]).unwrap_or(0)).sum()
    }

    // Everything from [from, to) (unix seconds).
    pub fn delete_range(&self, from: u64, to: u64) -> usize {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM visits WHERE visited_at >= ?1 AND visited_at < ?2", params![from as i64, to as i64]).unwrap_or(0)
    }

    pub fn delete_site(&self, site: &str) -> usize {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM visits WHERE host = ?1", params![site.trim_start_matches("www.").to_lowercase()]).unwrap_or(0)
    }

    pub fn clear(&self) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute("DELETE FROM visits", []);
        let _ = conn.execute_batch("VACUUM;");
    }

    // Forgets visits older than `days` days (0 = keep everything).
    pub fn prune(&self, days: u32, now: u64) {
        if days == 0 {
            return;
        }
        let cutoff = now.saturating_sub(days as u64 * 86_400);
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute("DELETE FROM visits WHERE visited_at < ?1", params![cutoff as i64]);
    }

    pub fn count(&self) -> u64 {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT COUNT(*) FROM visits", [], |r| r.get::<_, i64>(0)).unwrap_or(0) as u64
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_history() -> (History, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("kessel-history-test-{}-{}", std::process::id(), rand_suffix()));
        std::fs::create_dir_all(&dir).unwrap();
        (History::open(&dir), dir)
    }

    fn rand_suffix() -> u32 {
        use rand::RngExt;
        rand::rng().random_range(0..u32::MAX)
    }

    #[test]
    fn records_searches_and_deletes() {
        let (h, dir) = temp_history();
        h.record("https://www.youtube.com/watch?v=1", "", 1_000);
        h.set_title("https://www.youtube.com/watch?v=1", "Formula 1 highlights");
        h.record("https://en.wikipedia.org/wiki/Formula_One", "Formula One - Wikipedia", 2_000);
        h.record("https://en.wikipedia.org/wiki/Formula_One", "Formula One - Wikipedia", 2_500); // same page again
        h.record("https://example.com/", "Example", 3_000);
        assert_eq!(h.count(), 3, "going to the page you're on refreshes its entry");

        let all = h.query("", None, None, None, 100, 0);
        assert_eq!(all[0].url, "https://example.com/", "newest first");
        assert_eq!(all[1].visited_at, 2_500);

        let f1 = h.query("formula", None, None, None, 100, 0);
        assert_eq!(f1.len(), 2, "title or address, any case");
        assert_eq!(h.query("formula wikipedia", None, None, None, 100, 0).len(), 1, "every word must match");
        assert_eq!(h.query("100%", None, None, None, 100, 0).len(), 0, "% is literal");

        assert_eq!(h.query("", Some(1_500), Some(2_600), None, 100, 0).len(), 1, "by date");
        assert_eq!(h.query("", None, None, Some("youtube.com"), 100, 0).len(), 1, "by site, www. or not");

        let sites = h.sites("", 10);
        assert_eq!(sites.len(), 3);

        assert_eq!(h.delete(&[all[0].id]), 1);
        assert_eq!(h.delete_range(0, 1_500), 1);
        assert_eq!(h.delete_site("en.wikipedia.org"), 1);
        assert_eq!(h.count(), 0);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn prunes_old_visits() {
        let (h, dir) = temp_history();
        h.record("https://old.example/", "Old", 1_000);
        h.record("https://new.example/", "New", 100 * 86_400);
        h.prune(90, 100 * 86_400);
        let left = h.query("", None, None, None, 10, 0);
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].url, "https://new.example/");
        let _ = std::fs::remove_dir_all(dir);
    }
}
