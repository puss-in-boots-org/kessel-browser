// Extensions' blocking rules (Chrome's declarativeNetRequest), applied by
// Kessel's own request filter -- the WebResourceRequested hook Shields uses
// (main.rs install_shields_hooks) -- instead of the engine, which ignores
// them for extensions it runs.
//
// What's covered: the static rulesets an extension's manifest names (the
// ones it turns on by default, or the ones it picked since), and rules it
// adds while it runs (dynamic ones, kept; session ones, until Kessel
// closes). Actions: block, allow, upgradeScheme and redirect (to an address
// or to a file of the extension). Conditions: urlFilter, regexFilter,
// requestDomains / excludedRequestDomains, initiatorDomains /
// excludedInitiatorDomains, resourceTypes / excludedResourceTypes,
// domainType, isUrlFilterCaseSensitive. Header changes and the rest
// (modifyHeaders, allowAllRequests across a frame's requests, regex
// substitution) are not yet.
//
// Each extension's rules are evaluated on their own, highest priority first
// (an allow beats a block of the same priority, as in Chrome); across
// extensions a block wins, then a redirect, then an upgrade.
//
// Blockers ship tens of thousands of rules, and every request is checked:
// rules tied to sites (requestDomains, or a urlFilter starting "||host")
// are indexed by site, so a request only looks at the few for its own
// host plus the handful that apply anywhere.

use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    Block,
    Allow,
    Upgrade,
    // Where to: a whole address.
    Redirect(String),
}

impl Action {
    // Chrome's order among rules of the same priority.
    fn rank(&self) -> u8 {
        match self {
            Action::Allow => 4,
            Action::Block => 3,
            Action::Upgrade => 2,
            Action::Redirect(_) => 1,
        }
    }
}

#[derive(Debug, Clone)]
enum Filter {
    // urlFilter, split at its wildcards: (left anchor, pieces, right anchor).
    Pattern { start: Anchor, parts: Vec<String>, end: bool },
    Regex(regex::Regex),
    Any,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Anchor {
    None,
    // "|": the very start of the address.
    Start,
    // "||": the start of the host or of one of its parent domains.
    Domain,
}

#[derive(Debug, Clone)]
pub struct Rule {
    #[cfg_attr(not(test), allow(dead_code))]
    pub id: i64,
    priority: i64,
    action: Action,
    filter: Filter,
    case_sensitive: bool,
    request_domains: Vec<String>,
    excluded_request_domains: Vec<String>,
    initiator_domains: Vec<String>,
    excluded_initiator_domains: Vec<String>,
    // None: every type but the main frame.
    resource_types: Option<Vec<String>>,
    excluded_resource_types: Vec<String>,
    // Some(true): third-party only; Some(false): first-party only.
    third_party: Option<bool>,
}

// One request, as the rules see it.
pub struct Request<'a> {
    pub url: &'a str,
    // Its host, lower case.
    pub host: &'a str,
    // The page's host (its initiator), lower case; "" if none.
    pub initiator: &'a str,
    // A DNR resource type: "script", "image", "sub_frame", ...
    pub kind: &'a str,
}

// What WebView2 says a request is (main.rs request_kind) in DNR's words.
pub fn dnr_type(kessel_kind: &str) -> &'static str {
    match kessel_kind {
        "subdocument" => "sub_frame",
        "stylesheet" => "stylesheet",
        "image" => "image",
        "media" => "media",
        "font" => "font",
        "script" => "script",
        "xmlhttprequest" | "fetch" => "xmlhttprequest",
        "websocket" => "websocket",
        "ping" => "ping",
        _ => "other",
    }
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().filter_map(|s| s.as_str().map(|s| s.to_ascii_lowercase())).collect()).unwrap_or_default()
}

// Whether `host` is `domain` or under it.
fn under(host: &str, domain: &str) -> bool {
    host == domain || (host.len() > domain.len() && host.ends_with(domain) && host.as_bytes()[host.len() - domain.len() - 1] == b'.')
}

fn any_under(host: &str, domains: &[String]) -> bool {
    domains.iter().any(|d| under(host, d))
}

// The site part of a host, roughly (the last two labels -- three for
// "co.uk"-style ones): for first- and third-party.
fn site_of(host: &str) -> &str {
    let labels: Vec<&str> = host.split('.').collect();
    if labels.len() <= 2 {
        return host;
    }
    let second = labels[labels.len() - 2];
    let keep = if second.len() <= 3 && labels[labels.len() - 1].len() == 2 && labels.len() >= 3 { 3 } else { 2 };
    let skip: usize = labels[..labels.len() - keep].iter().map(|l| l.len() + 1).sum();
    &host[skip..]
}

impl Rule {
    // One rule from the extension's JSON; None if Kessel can't apply it
    // (an action it doesn't do yet, a broken pattern).
    pub fn parse(v: &Value, base_url: &str) -> Option<Rule> {
        let id = v["id"].as_i64()?;
        let a = &v["action"];
        let action = match a["type"].as_str()? {
            "block" => Action::Block,
            "allow" | "allowAllRequests" => Action::Allow,
            "upgradeScheme" => Action::Upgrade,
            "redirect" => {
                let r = &a["redirect"];
                if let Some(url) = r["url"].as_str() {
                    Action::Redirect(url.to_string())
                } else if let Some(path) = r["extensionPath"].as_str() {
                    Action::Redirect(format!("{}{}", base_url, path.trim_start_matches('/')))
                } else {
                    return None;
                }
            }
            _ => return None,
        };
        let c = &v["condition"];
        let case_sensitive = c["isUrlFilterCaseSensitive"].as_bool().unwrap_or(false);
        let filter = if let Some(f) = c["urlFilter"].as_str() {
            parse_url_filter(f, case_sensitive)
        } else if let Some(r) = c["regexFilter"].as_str() {
            let r = if case_sensitive { r.to_string() } else { format!("(?i){r}") };
            Filter::Regex(regex::Regex::new(&r).ok()?)
        } else {
            Filter::Any
        };
        // (The old names, from before Chrome 101.)
        let pick = |new: &str, old: &str| if c[new].is_array() { strings(&c[new]) } else { strings(&c[old]) };
        let resource_types = c["resourceTypes"].is_array().then(|| strings(&c["resourceTypes"]));
        Some(Rule {
            id,
            priority: v["priority"].as_i64().unwrap_or(1),
            action,
            filter,
            case_sensitive,
            request_domains: pick("requestDomains", "domains_unused"),
            excluded_request_domains: pick("excludedRequestDomains", "excludedDomains_unused"),
            initiator_domains: pick("initiatorDomains", "domains"),
            excluded_initiator_domains: pick("excludedInitiatorDomains", "excludedDomains"),
            resource_types,
            excluded_resource_types: strings(&c["excludedResourceTypes"]),
            third_party: match c["domainType"].as_str() {
                Some("thirdParty") => Some(true),
                Some("firstParty") => Some(false),
                _ => None,
            },
        })
    }

    // The hosts this rule is tied to, for the index: its requestDomains, or
    // the host of a "||host..." filter. Empty: it can match anywhere.
    fn index_hosts(&self) -> Vec<String> {
        if !self.request_domains.is_empty() {
            return self.request_domains.clone();
        }
        if let Filter::Pattern { start: Anchor::Domain, parts, .. } = &self.filter {
            if let Some(first) = parts.first() {
                // "||ads.example.com^" -> "ads.example.com": the part up to
                // the first character that can't be in a host.
                let host: String = first.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '-').collect::<String>().to_ascii_lowercase();
                // Only a whole host (followed by a separator or nothing) --
                // "||ads" would also cover "adserver.com".
                let rest = &first[host.len()..];
                if host.contains('.') && !host.ends_with('.') && (rest.is_empty() && parts.len() == 1 || rest.starts_with('^') || rest.starts_with('/') || rest.starts_with(':')) {
                    return vec![host];
                }
            }
        }
        Vec::new()
    }

    fn matches(&self, r: &Request) -> bool {
        match &self.resource_types {
            Some(types) => {
                if !types.iter().any(|t| t == r.kind) {
                    return false;
                }
            }
            None => {
                if r.kind == "main_frame" {
                    return false;
                }
            }
        }
        if self.excluded_resource_types.iter().any(|t| t == r.kind) {
            return false;
        }
        if !self.request_domains.is_empty() && !any_under(r.host, &self.request_domains) {
            return false;
        }
        if any_under(r.host, &self.excluded_request_domains) {
            return false;
        }
        if !self.initiator_domains.is_empty() && (r.initiator.is_empty() || !any_under(r.initiator, &self.initiator_domains)) {
            return false;
        }
        if !r.initiator.is_empty() && any_under(r.initiator, &self.excluded_initiator_domains) {
            return false;
        }
        if let Some(third) = self.third_party {
            let is_third = !r.initiator.is_empty() && site_of(r.host) != site_of(r.initiator);
            if is_third != third {
                return false;
            }
        }
        match &self.filter {
            Filter::Any => true,
            Filter::Regex(re) => re.is_match(r.url),
            Filter::Pattern { start, parts, end } => {
                if self.case_sensitive {
                    pattern_matches(r.url, r.host, *start, parts, *end)
                } else {
                    pattern_matches(&r.url.to_ascii_lowercase(), r.host, *start, parts, *end)
                }
            }
        }
    }
}

fn parse_url_filter(f: &str, case_sensitive: bool) -> Filter {
    let mut s = f;
    let start = if let Some(rest) = s.strip_prefix("||") {
        s = rest;
        Anchor::Domain
    } else if let Some(rest) = s.strip_prefix('|') {
        s = rest;
        Anchor::Start
    } else {
        Anchor::None
    };
    let end = s.ends_with('|') && !s.is_empty();
    if end {
        s = &s[..s.len() - 1];
    }
    let s = if case_sensitive { s.to_string() } else { s.to_ascii_lowercase() };
    let parts: Vec<String> = s.split('*').map(str::to_string).collect();
    if parts.iter().all(|p| p.is_empty()) && start == Anchor::None && !end {
        return Filter::Any;
    }
    Filter::Pattern { start, parts, end }
}

// "^": anything but a letter, digit or one of _ - . % -- or the end.
fn is_separator(c: u8) -> bool {
    !(c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-' | b'.' | b'%'))
}

// Whether `piece` (with "^" for separators) is at `url[at..]`: the length it
// takes. A trailing "^" may also match the end of the address.
fn piece_at(url: &[u8], at: usize, piece: &[u8]) -> Option<usize> {
    let mut i = at;
    for (k, &p) in piece.iter().enumerate() {
        if p == b'^' {
            if i == url.len() {
                // Only a last "^" can stand for the end.
                return if k == piece.len() - 1 { Some(i - at) } else { None };
            }
            if !is_separator(url[i]) {
                return None;
            }
        } else if i >= url.len() || url[i] != p {
            return None;
        }
        i += 1;
    }
    Some(i - at)
}

fn find_piece(url: &[u8], from: usize, piece: &[u8]) -> Option<(usize, usize)> {
    if piece.is_empty() {
        return Some((from, 0));
    }
    (from..=url.len()).find_map(|at| piece_at(url, at, piece).map(|len| (at, len)))
}

// Where the host starts in `url` ("https://" -> 8), and where each of its
// parent domains starts: the places a "||" filter may begin.
fn domain_starts(url: &str, host: &str) -> Vec<usize> {
    let Some(scheme_end) = url.find("://") else { return Vec::new() };
    let mut at = scheme_end + 3;
    // Skip "user:pass@".
    if let Some(slash) = url[at..].find('/') {
        if let Some(atsign) = url[at..at + slash].rfind('@') {
            at += atsign + 1;
        }
    } else if let Some(atsign) = url[at..].rfind('@') {
        at += atsign + 1;
    }
    let mut out = vec![at];
    for (i, b) in host.bytes().enumerate() {
        if b == b'.' && i + 1 < host.len() {
            out.push(at + i + 1);
        }
    }
    out
}

fn pattern_matches(url: &str, host: &str, start: Anchor, parts: &[String], end: bool) -> bool {
    let bytes = url.as_bytes();
    let starts: Vec<usize> = match start {
        Anchor::Start => vec![0],
        Anchor::Domain => domain_starts(url, host),
        Anchor::None => (0..=bytes.len()).collect(),
    };
    let first = parts[0].as_bytes();
    for s in starts {
        let Some(len) = piece_at(bytes, s, first) else { continue };
        let mut pos = s + len;
        let mut ok = true;
        for (k, piece) in parts.iter().enumerate().skip(1) {
            let last = k == parts.len() - 1;
            if last && end {
                // The last piece must sit at the very end.
                let p = piece.as_bytes();
                let ends_here = bytes.len() >= p.len() && bytes.len() - p.len() >= pos && piece_at(bytes, bytes.len() - p.len(), p).is_some();
                if !ends_here {
                    ok = false;
                }
                pos = bytes.len();
                break;
            }
            match find_piece(bytes, pos, piece.as_bytes()) {
                Some((at, l)) => pos = at + l,
                None => {
                    ok = false;
                    break;
                }
            }
        }
        if ok && (!end || pos == bytes.len() || parts.len() > 1) {
            return true;
        }
        // An anchored start has only its few places to try; unanchored ones
        // with a first piece found once and failing later won't do better
        // further on for a filter without wildcards.
        if start == Anchor::None && parts.len() == 1 && !end {
            return false;
        }
    }
    false
}

// One extension's rules, indexed.
#[derive(Default)]
pub struct RuleSet {
    rules: Vec<Rule>,
    by_host: HashMap<String, Vec<usize>>,
    anywhere: Vec<usize>,
}

impl RuleSet {
    pub fn new(rules: Vec<Rule>) -> RuleSet {
        let mut set = RuleSet { rules, ..Default::default() };
        for (i, r) in set.rules.iter().enumerate() {
            let hosts = r.index_hosts();
            if hosts.is_empty() {
                set.anywhere.push(i);
            } else {
                for h in hosts {
                    set.by_host.entry(h).or_default().push(i);
                }
            }
        }
        set
    }

    // The rule that decides `r`, if any.
    pub fn decide(&self, r: &Request) -> Option<&Rule> {
        let mut best: Option<&Rule> = None;
        let mut consider = |i: usize| {
            let rule = &self.rules[i];
            let better = match best {
                None => true,
                Some(b) => (rule.priority, rule.action.rank()) > (b.priority, b.action.rank()),
            };
            if better && rule.matches(r) {
                best = Some(rule);
            }
        };
        // The host and each of its parent domains.
        let mut h = r.host;
        loop {
            if let Some(list) = self.by_host.get(h) {
                list.iter().for_each(|&i| consider(i));
            }
            match h.find('.') {
                Some(dot) => h = &h[dot + 1..],
                None => break,
            }
        }
        self.anywhere.iter().for_each(|&i| consider(i));
        best
    }
}

// Rules from a ruleset file's JSON (an array of rules).
pub fn parse_rules(json: &Value, base_url: &str) -> Vec<Rule> {
    json.as_array().map(|a| a.iter().filter_map(|r| Rule::parse(r, base_url)).collect()).unwrap_or_default()
}

// What all extensions together do with `r`: None lets it through.
pub fn verdict<'a>(sets: impl Iterator<Item = &'a RuleSet>, r: &Request) -> Option<Action> {
    let mut out: Option<Action> = None;
    for set in sets {
        let Some(rule) = set.decide(r) else { continue };
        let a = &rule.action;
        let stronger = match (&out, a) {
            (_, Action::Allow) => false,
            (None, _) => true,
            (Some(Action::Block), _) => false,
            (Some(_), Action::Block) => true,
            (Some(Action::Upgrade), Action::Redirect(_)) => true,
            _ => false,
        };
        if stronger {
            out = Some(a.clone());
        }
    }
    // Upgrading only means something for http:// and ws://.
    if out == Some(Action::Upgrade) && !(r.url.starts_with("http://") || r.url.starts_with("ws://")) {
        return None;
    }
    out
}

// The https:// (or wss://) address for an upgrade.
pub fn upgraded(url: &str) -> String {
    if let Some(rest) = url.strip_prefix("http://") {
        format!("https://{rest}")
    } else if let Some(rest) = url.strip_prefix("ws://") {
        format!("wss://{rest}")
    } else {
        url.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn req<'a>(url: &'a str, host: &'a str, initiator: &'a str, kind: &'a str) -> Request<'a> {
        Request { url, host, initiator, kind }
    }

    fn set(rules: Value) -> RuleSet {
        RuleSet::new(parse_rules(&rules, "https://x.ext.kessel/"))
    }

    #[test]
    fn domain_anchor_and_separator() {
        let s = set(json!([{ "id": 1, "action": { "type": "block" }, "condition": { "urlFilter": "||ads.example.com^" } }]));
        assert!(s.decide(&req("https://ads.example.com/x.js", "ads.example.com", "news.site", "script")).is_some());
        assert!(s.decide(&req("https://cdn.ads.example.com/x.js", "cdn.ads.example.com", "news.site", "script")).is_some());
        assert!(s.decide(&req("https://ads.example.com", "ads.example.com", "news.site", "script")).is_some());
        assert!(s.decide(&req("https://ads.example.community/x", "ads.example.community", "news.site", "script")).is_none());
        assert!(s.decide(&req("https://badads.example.com/x", "badads.example.com", "news.site", "script")).is_none());
        // Never the page itself unless asked for.
        assert!(s.decide(&req("https://ads.example.com/", "ads.example.com", "", "main_frame")).is_none());
    }

    #[test]
    fn wildcards_and_anchors() {
        let s = set(json!([
            { "id": 1, "action": { "type": "block" }, "condition": { "urlFilter": "/banner/*.gif" } },
            { "id": 2, "action": { "type": "block" }, "condition": { "urlFilter": "|https://track." } },
            { "id": 3, "action": { "type": "block" }, "condition": { "urlFilter": ".exe|" } }
        ]));
        assert_eq!(s.decide(&req("https://a.com/img/banner/top.gif?x", "a.com", "a.com", "image")).map(|r| r.id), Some(1));
        assert!(s.decide(&req("https://a.com/img/banner/top.png", "a.com", "a.com", "image")).is_none());
        assert_eq!(s.decide(&req("https://track.b.com/p", "track.b.com", "a.com", "ping")).map(|r| r.id), Some(2));
        assert!(s.decide(&req("https://x.com/?u=https://track.b.com", "x.com", "a.com", "ping")).is_none());
        assert_eq!(s.decide(&req("https://x.com/setup.EXE", "x.com", "a.com", "other")).map(|r| r.id), Some(3));
        assert!(s.decide(&req("https://x.com/setup.exe?y", "x.com", "a.com", "other")).is_none());
    }

    #[test]
    fn domains_types_and_party() {
        let s = set(json!([{ "id": 1, "action": { "type": "block" }, "condition": {
            "requestDomains": ["tracker.net"], "excludedInitiatorDomains": ["friend.org"],
            "resourceTypes": ["script", "xmlhttprequest"], "domainType": "thirdParty" } }]));
        assert!(s.decide(&req("https://cdn.tracker.net/t.js", "cdn.tracker.net", "news.com", "script")).is_some());
        assert!(s.decide(&req("https://cdn.tracker.net/t.png", "cdn.tracker.net", "news.com", "image")).is_none());
        assert!(s.decide(&req("https://cdn.tracker.net/t.js", "cdn.tracker.net", "www.friend.org", "script")).is_none());
        assert!(s.decide(&req("https://cdn.tracker.net/t.js", "cdn.tracker.net", "www.tracker.net", "script")).is_none());
    }

    #[test]
    fn priorities_and_allow() {
        let s = set(json!([
            { "id": 1, "priority": 1, "action": { "type": "block" }, "condition": { "requestDomains": ["cdn.com"] } },
            { "id": 2, "priority": 1, "action": { "type": "allow" }, "condition": { "urlFilter": "||cdn.com/jquery" } },
            { "id": 3, "priority": 5, "action": { "type": "block" }, "condition": { "urlFilter": "jquery.evil" } }
        ]));
        let r = req("https://cdn.com/jquery.js", "cdn.com", "a.com", "script");
        assert_eq!(verdict([&s].into_iter(), &r), None);
        let r = req("https://cdn.com/jquery.evil.js", "cdn.com", "a.com", "script");
        assert_eq!(verdict([&s].into_iter(), &r), Some(Action::Block));
        let r = req("https://cdn.com/other.js", "cdn.com", "a.com", "script");
        assert_eq!(verdict([&s].into_iter(), &r), Some(Action::Block));
    }

    #[test]
    fn redirects_and_upgrades() {
        let s = set(json!([
            { "id": 1, "action": { "type": "redirect", "redirect": { "extensionPath": "/web_accessible_resources/noop.js" } }, "condition": { "urlFilter": "||ga.com/analytics.js" } },
            { "id": 2, "action": { "type": "upgradeScheme" }, "condition": { "requestDomains": ["plain.org"] } }
        ]));
        let r = req("https://ga.com/analytics.js", "ga.com", "a.com", "script");
        assert_eq!(verdict([&s].into_iter(), &r), Some(Action::Redirect("https://x.ext.kessel/web_accessible_resources/noop.js".into())));
        let r = req("http://plain.org/a.css", "plain.org", "a.com", "stylesheet");
        assert_eq!(verdict([&s].into_iter(), &r), Some(Action::Upgrade));
        assert_eq!(upgraded(r.url), "https://plain.org/a.css");
        let r = req("https://plain.org/a.css", "plain.org", "a.com", "stylesheet");
        assert_eq!(verdict([&s].into_iter(), &r), None);
    }

    #[test]
    fn regex_filters() {
        let s = set(json!([{ "id": 1, "action": { "type": "block" }, "condition": { "regexFilter": "^https://[a-z]+\\.ads\\.", "resourceTypes": ["image"] } }]));
        assert!(s.decide(&req("https://img.ads.example/x", "img.ads.example", "a.com", "image")).is_some());
        assert!(s.decide(&req("https://IMG.ads.example/x", "img.ads.example", "a.com", "image")).is_some());
        assert!(s.decide(&req("https://img.cdn.example/x", "img.cdn.example", "a.com", "image")).is_none());
    }

    #[test]
    fn index_keeps_whole_hosts_only() {
        let s = set(json!([{ "id": 1, "action": { "type": "block" }, "condition": { "urlFilter": "||ads" } }]));
        // Not indexed under a host: still found anywhere.
        assert!(s.decide(&req("https://adserver.com/x", "adserver.com", "a.com", "script")).is_some());
    }

    #[test]
    fn sites() {
        assert_eq!(site_of("a.b.example.com"), "example.com");
        assert_eq!(site_of("www.bbc.co.uk"), "bbc.co.uk");
        assert_eq!(site_of("localhost"), "localhost");
    }
}
