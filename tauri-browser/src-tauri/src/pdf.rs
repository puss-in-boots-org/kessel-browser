// PDFs in Kessel's own viewer: Mozilla's PDF.js (src/pdfjs), with what the
// engine's built-in viewer can't do -- page thumbnails, highlighting,
// drawing, text and images, signatures, comments, presentation mode, and
// saving a PDF with what you added. A tab going to a PDF goes to
// kessel://pdf?src=<its address> instead, and the viewer asks Kessel for
// the file: one from this computer is read as it is, one from the web is
// fetched with the tab's own cookies (so PDFs behind a sign-in open too).
// Settings -> Page tools can hand PDFs back to the engine's viewer.
//
// Saving (pdf_save) doesn't go through the engine's downloads: the viewer
// hands Kessel the PDF's bytes -- with what you added, if anything -- and
// Kessel writes them itself, like Edge does: Save puts a PDF from this
// computer back where it came from, and one from the web in your downloads
// folder; Save as asks where.

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
    if !looks_like_pdf(&bytes) {
        return Err("That isn't a PDF".into());
    }
    Ok(tauri::ipc::Response::new(bytes))
}

// A PDF starts with "%PDF-" (somewhere in its first kilobyte).
fn looks_like_pdf(bytes: &[u8]) -> bool {
    bytes[..bytes.len().min(1024)].windows(5).any(|w| w == b"%PDF-")
}

// What the viewer says about a file it's saving (the x-kessel-save header,
// URI-encoded JSON).
#[derive(serde::Deserialize, Default)]
struct SaveRequest {
    // The PDF's own address (pdf_bytes' `src`).
    #[serde(default)]
    src: String,
    // The name to suggest.
    #[serde(default)]
    name: String,
    // Save as: always ask where.
    #[serde(default)]
    ask: bool,
    // A file attached inside the PDF (any kind of file): asks where too.
    #[serde(default)]
    attachment: bool,
}

// "%7B%22a%22..." -> "{\"a\"...", as encodeURIComponent made it.
fn uri_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

// The name to save as: no characters Windows refuses, not too long, and a
// PDF ends in .pdf.
fn save_name(name: &str, pdf: bool) -> String {
    let clean = crate::tools::safe_file_name(name.trim());
    let clean: String = clean.chars().take(150).collect::<String>().trim_end_matches(['.', ' ']).to_string();
    let clean = if clean.is_empty() { if pdf { "document".to_string() } else { "attachment".to_string() } } else { clean };
    if pdf && !clean.to_ascii_lowercase().ends_with(".pdf") {
        format!("{clean}.pdf")
    } else {
        clean
    }
}

// Writes `bytes` to `path` without leaving half a file if something fails
// (a temporary file next to it, then moved over it).
fn write_whole(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    let mut temp = path.as_os_str().to_owned();
    temp.push(".kessel-saving");
    let temp = PathBuf::from(temp);
    std::fs::write(&temp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&temp, path).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        e.to_string()
    })
}

// The viewer's Save and Save as (kessel-pdf.js): the file's bytes are the
// request's body. Where it was saved, or None if you cancelled.
#[tauri::command]
pub(crate) async fn pdf_save(app: tauri::AppHandle, webview: Webview, request: tauri::ipc::Request<'_>) -> Result<Option<String>, String> {
    require_internal_page(&webview)?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("Nothing to save".into()) };
    let bytes = bytes.clone();
    let how: SaveRequest = request
        .headers()
        .get("x-kessel-save")
        .and_then(|v| v.to_str().ok())
        .and_then(uri_decode)
        .and_then(|j| serde_json::from_str(&j).ok())
        .unwrap_or_default();
    if !how.attachment && !looks_like_pdf(&bytes) {
        return Err("That isn't a PDF".into());
    }
    let name = save_name(&how.name, !how.attachment);
    let src = tauri::Url::parse(&how.src).ok();
    // Save, on a PDF from this computer: back into its own file.
    let own_file = src
        .as_ref()
        .filter(|u| u.scheme() == "file" && !how.ask && !how.attachment)
        .and_then(|u| u.to_file_path().ok())
        .filter(|p| p.is_file() && p.extension().is_some_and(|e| e.eq_ignore_ascii_case("pdf")));
    let ask = how.ask || how.attachment || (own_file.is_none() && downloads::ask_every_time(&app));
    let (path, in_list) = if let Some(path) = own_file {
        (path, false)
    } else if ask {
        let filters: Vec<(&str, &str)> = if how.attachment { vec![("All files", "*.*")] } else { vec![("PDF", "*.pdf")] };
        let title = if how.attachment { "Save the attachment" } else { "Save the PDF" };
        let suggested = name.clone();
        let filters: Vec<(String, String)> = filters.into_iter().map(|(a, b)| (a.to_string(), b.to_string())).collect();
        let picked = crate::extensions::dialog(&app, &webview, move |owner| {
            let filters: Vec<(&str, &str)> = filters.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
            crate::dialogs::save_file(owner, title, &suggested, &filters)
        })
        .await?;
        let Some(path) = picked else { return Ok(None) };
        (path, true)
    } else {
        // Save, on a PDF from the web: into your downloads folder, like any
        // download (sorted by kind, if you asked for that).
        let mut dir = downloads::download_dir(&app).ok_or("There's no downloads folder")?;
        if let Some(folder) = downloads::kind_folder(&app, &name) {
            if std::fs::create_dir_all(dir.join(folder)).is_ok() {
                dir = dir.join(folder);
            }
        }
        (downloads::unique_path(&dir, &name), true)
    };
    let target = path.clone();
    tauri::async_runtime::spawn_blocking(move || write_whole(&target, &bytes)).await.map_err(|e| e.to_string())??;
    let saved = path.to_string_lossy().to_string();
    // In Kessel's downloads list, like a download (a PDF saved back into its
    // own file isn't a new one).
    if in_list {
        let st = app.state::<BrowserState>();
        let entry = DownloadEntry {
            id: st.next_download_id.fetch_add(1, Ordering::SeqCst),
            url: how.src.clone(),
            path: saved.clone(),
            finished: true,
            success: true,
            started_at: now_unix(),
        };
        st.store.downloads.lock().unwrap().push(entry);
        st.store.save_downloads();
        let _ = app.emit("downloads-changed", ());
    }
    Ok(Some(saved))
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
    fn saving_a_pdf() {
        assert!(looks_like_pdf(b"%PDF-1.7\n..."));
        assert!(looks_like_pdf(b"\xef\xbb\xbf  %PDF-1.4"), "a little junk before it");
        assert!(!looks_like_pdf(b"<html>"));
        assert!(!looks_like_pdf(b"%PD"));
        assert_eq!(uri_decode("%7B%22name%22%3A%22R%C3%A9sum%C3%A9.pdf%22%7D").as_deref(), Some("{\"name\":\"Résumé.pdf\"}"));
        assert_eq!(uri_decode("bad%2"), None);
        assert_eq!(save_name("Report", true), "Report.pdf");
        assert_eq!(save_name("Report.PDF", true), "Report.PDF");
        assert_eq!(save_name("a/b:c?.pdf", true), "a_b_c_.pdf");
        assert_eq!(save_name("  ", true), "document.pdf");
        assert_eq!(save_name("notes.txt", false), "notes.txt");
        assert_eq!(save_name("x.", false), "x");
    }

    #[test]
    fn a_save_replaces_the_whole_file() {
        let dir = std::env::temp_dir().join(format!("kessel-pdf-save-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.pdf");
        std::fs::write(&file, b"%PDF-old and longer").unwrap();
        write_whole(&file, b"%PDF-new").unwrap();
        assert_eq!(std::fs::read(&file).unwrap(), b"%PDF-new");
        assert!(!dir.join("a.pdf.kessel-saving").exists());
        assert_eq!(downloads::unique_path(&dir, "a.pdf"), dir.join("a (1).pdf"));
        assert_eq!(downloads::unique_path(&dir, "b.pdf"), dir.join("b.pdf"));
        let _ = std::fs::remove_dir_all(&dir);
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
