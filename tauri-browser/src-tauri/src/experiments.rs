// Settings -> Network -> Experiments: some of the engine's own experiments,
// each a switch (part of how the engine starts, so after a restart). And
// the engine's command line made whole: Chromium takes only the last of
// several --enable-features= (or --disable-features=...), so every one of
// them -- Kessel's, these, your own switches -- becomes one.

// id, what it adds: switches, --enable-features, --disable-features.
pub(crate) const EXPERIMENTS: &[(&str, &[&str], &[&str], &[&str])] = &[
    ("web_platform", &["--enable-experimental-web-platform-features"], &[], &[]),
    ("parallel_downloads", &[], &["ParallelDownloading"], &[]),
    ("force_dark", &[], &["WebContentsForceDark"], &[]),
    ("no_smooth_scrolling", &["--disable-smooth-scrolling"], &[], &[]),
    ("no_quic", &["--disable-quic"], &[], &[]),
];

// The switches for the experiments you turned on (features.experiments).
pub(crate) fn args(features: &serde_json::Value) -> String {
    let on = |id: &str| features.get("experiments").and_then(|e| e.get(id)).and_then(|v| v.as_bool()).unwrap_or(false);
    let mut out = String::new();
    for (id, switches, enable, disable) in EXPERIMENTS {
        if !on(id) {
            continue;
        }
        for s in *switches {
            out.push(' ');
            out.push_str(s);
        }
        if !enable.is_empty() {
            out.push_str(&format!(" --enable-features={}", enable.join(",")));
        }
        if !disable.is_empty() {
            out.push_str(&format!(" --disable-features={}", disable.join(",")));
        }
    }
    out
}

const LISTS: [&str; 4] = ["--enable-features=", "--disable-features=", "--enable-blink-features=", "--disable-blink-features="];

// One of each feature list, everything in it kept (in order, once); every
// other switch as it was.
pub(crate) fn merge_feature_lists(args: &str) -> String {
    let mut lists: Vec<Vec<String>> = vec![Vec::new(); LISTS.len()];
    let mut rest: Vec<&str> = Vec::new();
    for arg in args.split_whitespace() {
        match LISTS.iter().position(|p| arg.starts_with(p)) {
            Some(i) => {
                for name in arg[LISTS[i].len()..].split(',').map(str::trim).filter(|n| !n.is_empty()) {
                    if !lists[i].iter().any(|n| n == name) {
                        lists[i].push(name.to_string());
                    }
                }
            }
            None => rest.push(arg),
        }
    }
    let mut out: Vec<String> = rest.into_iter().map(str::to_string).collect();
    for (i, names) in lists.iter().enumerate() {
        if !names.is_empty() {
            out.push(format!("{}{}", LISTS[i], names.join(",")));
        }
    }
    out.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn experiments_become_switches() {
        let f = serde_json::json!({ "experiments": { "web_platform": true, "parallel_downloads": true, "no_quic": false, "made_up": true } });
        let a = args(&f);
        assert!(a.contains("--enable-experimental-web-platform-features"));
        assert!(a.contains("--enable-features=ParallelDownloading"));
        assert!(!a.contains("quic"), "only what's on");
        assert_eq!(args(&serde_json::json!({})), "");
    }

    #[test]
    fn one_of_each_feature_list() {
        let merged = merge_feature_lists("--disable-features=msWebOOUI,msPdfOOUI --enable-blink-features=AudioVideoTracks --no-proxy-server --enable-features=ParallelDownloading --disable-features=Foo --enable-features=KesselTestFlag,ParallelDownloading");
        assert_eq!(merged.matches("--enable-features=").count(), 1);
        assert_eq!(merged.matches("--disable-features=").count(), 1);
        assert!(merged.contains("--enable-features=ParallelDownloading,KesselTestFlag"));
        assert!(merged.contains("--disable-features=msWebOOUI,msPdfOOUI,Foo"), "Kessel's own kept with yours");
        assert!(merged.contains("--enable-blink-features=AudioVideoTracks") && merged.starts_with("--no-proxy-server"));
    }
}
