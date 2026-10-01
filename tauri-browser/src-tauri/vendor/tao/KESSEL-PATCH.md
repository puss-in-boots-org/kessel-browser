# tao 0.35.3, patched for Kessel

This is [tao](https://github.com/tauri-apps/tao) 0.35.3 as published on
crates.io (Apache-2.0 / MIT, see the LICENSE files), used through
`[patch.crates-io]` in `../../Cargo.toml`. Two things are changed, both on
Windows and both marked `KESSEL PATCH`:

- `src/platform_impl/windows/event_loop.rs`, `WM_NCCALCSIZE`: a maximized
  borderless window's client area is cut to the monitor's work area (so it
  doesn't cover the taskbar) -- now only when it isn't in full screen.
- `src/platform_impl/windows/window.rs`, `set_fullscreen(None)`: a window that
  was maximized before full screen is put back in its normal place first and
  then maximized with `ShowWindow(SW_MAXIMIZE)`, instead of only getting its
  saved (maximized) placement back.

## Why

Kessel's windows are borderless, and most people keep them maximized. When a
page goes full screen (a video's full-screen button), tauri-runtime-wry's own
`ContainsFullScreenElementChanged` handler calls `set_fullscreen`, which moves
the window over the whole monitor -- but the window stays *maximized* as far
as Windows is concerned. Two things then went wrong:

1. **In full screen**, `WM_NCCALCSIZE` still treated it as a maximized
   borderless window and cut its client area to the work area: the page (and
   the video) stopped where the taskbar starts, with a strip below it.
2. **Coming back**, `SetWindowPlacement` with the saved maximized placement
   does nothing to a window that is already maximized, so it stayed
   monitor-sized at (0, 0), over the taskbar, instead of returning to its
   maximized place.

F11 (Kessel's own full screen) went through the same code and had the same
two problems. Windows that weren't maximized were never affected.

The end-to-end test `shortcuts > a video's full screen from a maximized
window ...` (`tests/e2e/tests/shortcuts.test.mjs`) covers both; it needs the
screen, like the other tests in that file.

## Updating tao

Copy the new version's crate from `~/.cargo/registry/src/*/tao-<version>`
here (without `Cargo.toml.orig` and `Cargo.lock`), re-apply the two changes
(search for `KESSEL PATCH` in this copy), and run the test above.
