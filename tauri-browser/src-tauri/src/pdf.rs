// PDFs in Kessel's own viewer: Mozilla's PDF.js (src/pdfjs), with what the
// engine's built-in viewer can't do -- page thumbnails, highlighting,
// drawing, text and images, signatures, comments, presentation mode, and
// saving a PDF with what you added. A tab going to a PDF goes to
// kessel://pdf?src=<its address> instead, and the viewer asks Kessel for
// the file: one from this computer is read as it is, one from the web is
// fetched with the tab's own cookies (so PDFs behind a sign-in open too).
// Settings -> Page tools can hand PDFs back to the engine's viewer.

use super::*;

fn enabled(app: &tauri::AppHandle) -> bool {
    app.state::<BrowserState>().store.settings.lock().unwrap().features.get("pdf_viewer").and_then(|v| v.as_str()) != Some("engine")
}

pub(crate) fn is_pdf_address(url: &tauri::Url) -> bool {
    matches!(url.scheme(), "http" | "https" | "file") && url.path().to_ascii_lowercase().ends_with(".pdf")
}

// The viewer's own address for the PDF at `src` (in Kessel's own origin).
fn viewer_url(app: &tauri::AppHandle, src: &str) -> Option<String> {
    let toolbar = app.webviews().into_iter().find(|(label, _)| label.starts_with("toolbar-")).and_then(|(_, w)| w.url().ok())?;
    let mut url = toolbar.join("/pdfjs/web/viewer.html").ok()?;
    url.query_pairs_mut().append_pair("src", src);
    Some(url.to_string())
}

// Page `id` (webview `label`) is about to go to `nav_url`: a PDF goes to the
// viewer instead (true: it does).
pub(crate) fn intercept(app: &tauri::AppHandle, id: u32, label: &str, nav_url: &tauri::Url) -> bool {
    if !is_pdf_address(nav_url) || !enabled(app) {
        return false;
    }
    let Some(target) = viewer_url(app, nav_url.as_str()).and_then(|u| tauri::Url::parse(&u).ok()) else { return false };
    let (app2, label2) = (app.clone(), label.to_string());
    later(app, move || {
        if let Some(page) = app2.get_webview(&label2) {
            // (Kessel sends it there: a website couldn't.)
            app2.state::<BrowserState>().internal_nav_allowed.lock().unwrap().insert(id);
            let _ = page.navigate(target);
        }
    });
    true
}

// The cookies the tab would send to `src` (the engine's own, HttpOnly ones
// too): "name=value; …".
async fn cookies_for(app: &tauri::AppHandle, webview: &Webview, src: &str) -> String {
    #[cfg(windows)]
    {
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        let Ok(target) = tauri::Url::parse(src) else { return String::new() };
        let host = target.host_str().unwrap_or("").to_ascii_lowercase();
        let (path, https) = (target.path().to_string(), target.scheme() == "https");
        let page = webview.clone();
        let _ = on_main(app, move || {
            let _ = page.with_webview(move |platform| unsafe {
                use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
                use windows::core::HSTRING;
                let Ok(core) = platform.controller().CoreWebView2() else { return };
                let done = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |result, json| {
                    let all = result.ok().and_then(|_| serde_json::from_str::<serde_json::Value>(&json).ok()).and_then(|v| v.get("cookies").and_then(|c| c.as_array()).cloned()).unwrap_or_default();
                    let header = all.iter().filter_map(|c| cookie_for(c, &host, &path, https)).collect::<Vec<_>>().join("; ");
                    let _ = tx.send(header);
                    Ok(())
                }));
                let _ = core.CallDevToolsProtocolMethod(&HSTRING::from("Network.getAllCookies"), &HSTRING::from("{}"), &done);
            });
        })
        .await;
        tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(5)).unwrap_or_default()).await.unwrap_or_default()
    }
    #[cfg(not(windows))]
    {
        let _ = (app, webview, src);
        String::new()
    }
}

// "name=value" when cookie `c` (as the engine lists it) goes with a request
// to `host` + `path`.
fn cookie_for(c: &serde_json::Value, host: &str, path: &str, https: bool) -> Option<String> {
    let domain = c.get("domain")?.as_str()?.to_ascii_lowercase();
    let bare = domain.trim_start_matches('.');
    let domain_ok = host == bare || (domain.starts_with('.') && host.ends_with(&format!(".{bare}")));
    let cookie_path = c.get("path").and_then(|p| p.as_str()).unwrap_or("/");
    let path_ok = path.starts_with(cookie_path) && (cookie_path.ends_with('/') || path.len() == cookie_path.len() || path[cookie_path.len()..].starts_with('/'));
    let secure_ok = https || !c.get("secure").and_then(|s| s.as_bool()).unwrap_or(false);
    if !(domain_ok && path_ok && secure_ok) {
        return None;
    }
    Some(format!("{}={}", c.get("name")?.as_str()?, c.get("value")?.as_str()?))
}

const MOST: u64 = 512 * 1024 * 1024;

// The PDF at `src`, for the viewer.
#[tauri::command]
pub(crate) async fn pdf_bytes(app: tauri::AppHandle, webview: Webview, src: String) -> Result<tauri::ipc::Response, String> {
    require_internal_page(&webview)?;
    let url = tauri::Url::parse(&src).map_err(|_| "That isn't an address".to_string())?;
    let bytes = match url.scheme() {
        "file" => {
            let path = url.to_file_path().map_err(|_| "That isn't a file on this computer".to_string())?;
            if !path.extension().is_some_and(|e| e.eq_ignore_ascii_case("pdf")) {
                return Err("Only PDF files".into());
            }
            tauri::async_runtime::spawn_blocking(move || std::fs::read(&path).map_err(|e| e.to_string())).await.map_err(|e| e.to_string())??
        }
        "http" | "https" => {
            let cookies = cookies_for(&app, &webview, &src).await;
            tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
                use ureq::tls::{RootCerts, TlsConfig, TlsProvider};
                let agent: ureq::Agent = ureq::Agent::config_builder()
                    .tls_config(TlsConfig::builder().provider(TlsProvider::NativeTls).root_certs(RootCerts::PlatformVerifier).build())
                    .timeout_global(Some(Duration::from_secs(120)))
                    .build()
                    .into();
                let mut request = agent.get(&src).header("Accept", "application/pdf,*/*");
                if !cookies.is_empty() {
                    request = request.header("Cookie", &cookies);
                }
                let mut response = request.call().map_err(|e| e.to_string())?;
                response.body_mut().with_config().limit(MOST).read_to_vec().map_err(|e| e.to_string())
            })
            .await
            .map_err(|e| e.to_string())??
        }
        _ => return Err("Only web and local PDFs".into()),
    };
    if !bytes.iter().take(1024).collect::<Vec<_>>().windows(5).any(|w| w.iter().map(|b| **b).eq(*b"%PDF-")) {
        return Err("That isn't a PDF".into());
    }
    Ok(tauri::ipc::Response::new(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn which_cookies_go_with_a_pdf() {
        let c = |domain: &str, path: &str, secure: bool| serde_json::json!({ "name": "s", "value": "1", "domain": domain, "path": path, "secure": secure });
        assert_eq!(cookie_for(&c("docs.example", "/", false), "docs.example", "/a/x.pdf", true).as_deref(), Some("s=1"));
        assert!(cookie_for(&c(".example", "/", false), "docs.example", "/x.pdf", true).is_some(), "a domain cookie, for its subdomains");
        assert!(cookie_for(&c("example", "/", false), "docs.example", "/x.pdf", true).is_none(), "a host-only cookie isn't");
        assert!(cookie_for(&c("docs.example", "/a", false), "docs.example", "/ab/x.pdf", true).is_none(), "/a isn't /ab");
        assert!(cookie_for(&c("docs.example", "/a", false), "docs.example", "/a/x.pdf", true).is_some());
        assert!(cookie_for(&c("docs.example", "/", true), "docs.example", "/x.pdf", false).is_none(), "a secure cookie only over https");
        assert!(cookie_for(&c("other.example", "/", false), "docs.example", "/x.pdf", true).is_none());
    }

    #[test]
    fn which_addresses_are_pdfs() {
        for yes in ["https://a.example/doc.pdf", "http://a.example/x/Report.PDF?download=1", "file:///C:/Docs/x.pdf"] {
            assert!(is_pdf_address(&tauri::Url::parse(yes).unwrap()), "{yes}");
        }
        for no in ["https://a.example/pdf", "https://a.example/doc.pdf.html", "kessel://pdf?src=x.pdf", "ftp://a.example/x.pdf"] {
            assert!(!is_pdf_address(&tauri::Url::parse(no).unwrap()), "{no}");
        }
    }
}
