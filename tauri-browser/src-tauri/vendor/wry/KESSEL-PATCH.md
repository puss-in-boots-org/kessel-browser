# wry 0.55.1, patched for Kessel

This is [wry](https://github.com/tauri-apps/wry) 0.55.1 as published on
crates.io (MIT / Apache-2.0, see the LICENSE files), used through
`[patch.crates-io]` in `../../Cargo.toml`. Only the files needed to build it
are here. One function is changed: `attach_ipc_handler` in
`src/webview2/mod.rs`, marked `KESSEL PATCH`.

## Why

wry listens to WebView2's `WebMessageReceived` event for Tauri's IPC, and its
handler did two things that broke Kessel:

1. **It returned an error for any message that isn't a string.** WebView2
   stops calling an event's other handlers once one fails, so Kessel's own
   handler (the page bridge, `src/bridge.rs`) never saw a message from a page:
   Ctrl/middle-click links, shortcuts a page hands back, Shields' element
   hiding and password autofill all silently did nothing on websites.
2. **It `unwrap()`ed the page's address as an `http::Uri`.** For a page whose
   address isn't one (`file:`, `about:`, `data:`, `blob:`, or anything longer
   than 64 KB) a string message panicked inside a COM callback, which aborts
   the whole browser. Any website could do that on purpose: navigate itself
   to a 70 KB address and call `chrome.webview.postMessage("x")`.

The patch makes the handler skip such messages (returning `Ok`) instead.
Tauri's own IPC is unaffected: it only ever sends strings, from Kessel's own
pages.

## Updating

When Tauri moves to a newer wry, copy that version here (`src`, `examples`,
`build.rs`, `Cargo.toml`, the licence files), re-apply the change -- or drop
this folder and the `[patch]` entry if wry fixed both points itself -- and
run the end-to-end tests: `shortcuts > Ctrl+click opens a link...` fails if
page messages stop arriving.
