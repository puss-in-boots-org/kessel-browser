// Sites whose service worker never starts (Gmail, chiefly).
//
// A WebView2 bug: while a webview has any WebResourceRequested filter --
// and every page webview has Kessel's, for Shields and the privacy headers
// -- a site's service worker that serves its pages through "static routes"
// (InstallEvent.addRoutes) often gets stuck starting for good once it's
// installed. The page itself comes from the worker's cache, but everything
// else it asks for waits on the worker, so the page never finishes loading:
// Gmail shows up without its icons, avatars or top bar, says "Not
// connected", and spins forever. A reload doesn't help; only stopping the
// stuck worker does, after which it starts normally. See
// https://github.com/MicrosoftEdge/WebView2Feedback/issues/5764
//
// So every page webview watches its service workers through the engine's
// DevTools protocol, and one that has been "starting" for a few seconds is
// stopped: its waiting requests then go through within a moment. A worker
// starts in well under a second normally, so a healthy one is never touched.

#![cfg_attr(not(windows), allow(dead_code))]

use super::*;

// How long a worker may take to start before it counts as stuck.
const STUCK_AFTER: Duration = Duration::from_secs(4);

// Per webview label: the workers starting right now, and since when.
static STARTING: Mutex<Option<HashMap<String, HashMap<String, Instant>>>> = Mutex::new(None);

// What a ServiceWorker.workerVersionUpdated event says, per worker version:
// its id, and whether it's an active worker that is starting.
pub(crate) fn parse_versions(json: &str) -> Vec<(String, bool)> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(json) else { return Vec::new() };
    let Some(versions) = value.get("versions").and_then(|v| v.as_array()) else { return Vec::new() };
    versions
        .iter()
        .filter_map(|v| {
            let id = v.get("versionId")?.as_str()?.to_string();
            let running = v.get("runningStatus").and_then(|s| s.as_str()).unwrap_or("");
            let status = v.get("status").and_then(|s| s.as_str()).unwrap_or("");
            Some((id, running == "starting" && status == "activated"))
        })
        .collect()
}

// Takes in an event's versions for webview `label`: returns the ones that
// just began starting (each to be looked at again in STUCK_AFTER).
pub(crate) fn note_versions(label: &str, versions: &[(String, bool)], now: Instant) -> Vec<String> {
    let mut all = STARTING.lock().unwrap();
    let starting = all.get_or_insert_with(HashMap::new).entry(label.to_string()).or_default();
    let mut began = Vec::new();
    for (id, is_starting) in versions {
        if *is_starting {
            if !starting.contains_key(id) {
                starting.insert(id.clone(), now);
                began.push(id.clone());
            }
        } else {
            starting.remove(id);
        }
    }
    began
}

// Whether worker `id` of webview `label` is still starting STUCK_AFTER on --
// if so it's forgotten here (it's about to be stopped; when it starts
// again, that's a new try).
pub(crate) fn take_if_stuck(label: &str, id: &str, now: Instant) -> bool {
    let mut all = STARTING.lock().unwrap();
    let Some(starting) = all.as_mut().and_then(|a| a.get_mut(label)) else { return false };
    match starting.get(id) {
        Some(since) if now.duration_since(*since) >= STUCK_AFTER => {
            starting.remove(id);
            true
        }
        _ => false,
    }
}

// The webview closed: nothing of it to remember.
pub(crate) fn forget(label: &str) {
    if let Some(all) = STARTING.lock().unwrap().as_mut() {
        all.remove(label);
    }
}

// Starts watching a page webview's service workers. On the main thread, as
// the webview is made (see install_shields_hooks).
#[cfg(windows)]
pub(crate) unsafe fn install_hooks(app: &tauri::AppHandle, core: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2, label: &str) {
    use webview2_com::{take_pwstr, CallDevToolsProtocolMethodCompletedHandler, DevToolsProtocolEventReceivedEventHandler};
    use windows::core::{HSTRING, PWSTR};

    let Ok(receiver) = core.GetDevToolsProtocolEventReceiver(&HSTRING::from("ServiceWorker.workerVersionUpdated")) else { return };
    let (app, label) = (app.clone(), label.to_string());
    let mut token = 0i64;
    let added = receiver.add_DevToolsProtocolEventReceived(
        &DevToolsProtocolEventReceivedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut json = PWSTR::null();
            args.ParameterObjectAsJson(&mut json)?;
            let versions = parse_versions(&take_pwstr(json));
            for id in note_versions(&label, &versions, Instant::now()) {
                let (app, label) = (app.clone(), label.clone());
                std::thread::spawn(move || {
                    std::thread::sleep(STUCK_AFTER);
                    let app2 = app.clone();
                    later(&app, move || {
                        if !take_if_stuck(&label, &id, Instant::now()) {
                            return;
                        }
                        let Some(webview) = app2.get_webview(&label) else {
                            forget(&label);
                            return;
                        };
                        eprintln!("service worker {id} in {label} stuck starting: stopping it");
                        let _ = webview.with_webview(move |platform| unsafe {
                            if let Ok(core) = platform.controller().CoreWebView2() {
                                let params = serde_json::json!({ "versionId": id }).to_string();
                                let done = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(|_, _| Ok(())));
                                let _ = core.CallDevToolsProtocolMethod(&HSTRING::from("ServiceWorker.stopWorker"), &HSTRING::from(params), &done);
                            }
                        });
                    });
                });
            }
            Ok(())
        })),
        &mut token,
    );
    if added.is_err() {
        return;
    }
    // The events only come once the domain is on.
    let done = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(|_, _| Ok(())));
    let _ = core.CallDevToolsProtocolMethod(&HSTRING::from("ServiceWorker.enable"), &HSTRING::from("{}"), &done);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_which_workers_are_starting() {
        let event = r#"{"versions":[
            {"versionId":"7","registrationId":"1","scriptURL":"https://mail.google.com/mail/sw.js","runningStatus":"starting","status":"activated"},
            {"versionId":"8","registrationId":"2","scriptURL":"https://a.example/sw.js","runningStatus":"running","status":"activated"},
            {"versionId":"9","registrationId":"3","scriptURL":"https://b.example/sw.js","runningStatus":"starting","status":"installing"}
        ]}"#;
        assert_eq!(parse_versions(event), vec![("7".into(), true), ("8".into(), false), ("9".into(), false)]);
        assert!(parse_versions("not json").is_empty());
        assert!(parse_versions("{}").is_empty());
    }

    #[test]
    fn only_a_worker_still_starting_after_a_while_is_stuck() {
        let t0 = Instant::now();
        let label = "content-test-stuck";
        assert_eq!(note_versions(label, &[("1".into(), true), ("2".into(), true)], t0), vec!["1", "2"]);
        // Reported again while still starting: no second check.
        assert!(note_versions(label, &[("1".into(), true)], t0 + Duration::from_millis(500)).is_empty());
        // Worker 2 got going.
        note_versions(label, &[("2".into(), false)], t0 + Duration::from_millis(300));
        assert!(!take_if_stuck(label, "1", t0 + Duration::from_secs(1)));
        assert!(take_if_stuck(label, "1", t0 + STUCK_AFTER));
        assert!(!take_if_stuck(label, "2", t0 + STUCK_AFTER));
        // Once stopped, it's forgotten: starting again is a new try.
        assert!(!take_if_stuck(label, "1", t0 + STUCK_AFTER * 2));
        assert_eq!(note_versions(label, &[("1".into(), true)], t0 + STUCK_AFTER * 2), vec!["1"]);
        forget(label);
        assert!(!take_if_stuck(label, "1", t0 + STUCK_AFTER * 4));
    }
}
