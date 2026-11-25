# Kessel's updates

Kessel updates itself from this repository's GitHub Releases. There is no
update server: every release carries a small `latest.json` file, and each
installed Kessel reads
`https://github.com/puss-in-boots-org/kessel-browser/releases/latest/download/latest.json`.

## What you see

- A minute after Kessel starts, then every six hours, it looks for a newer
  version. If there is one, it downloads it in the background.
- When the download is done and its signature checks out, an **Update ready**
  chip appears by the menu button. **Restart and update** runs the installer
  quietly (a small progress window, no questions) and starts Kessel again on
  the new version, with your tabs back. **Later** hides the chip; Settings ->
  About still offers the restart.
- After the update, an **Updated** chip links to the release notes.
- Settings -> About -> Updates shows where things stand, has **Check now**,
  and can turn automatic updates off (Kessel then only looks when you ask).

## How updates are kept safe

Updates are signed with Kessel's **updater key**, a free
[minisign](https://jedisct1.github.io/minisign/) key pair made by
`tauri signer generate`. This is not a Windows code-signing certificate and
costs nothing. The public half is in `tauri-browser/src-tauri/tauri.conf.json`
(`plugins.updater.pubkey`); Kessel refuses any download whose signature
doesn't match it, so a tampered installer is never run.

The private half signs releases. It lives only in the repository's secrets.

**Keep a copy of the private key somewhere safe (a password manager).** If
it's lost, installed copies of Kessel can't be updated any more: a new key
means a new public key in the app, and everyone would have to install that
version by hand once.

## Setting it up (once)

1. On GitHub: **Settings -> Secrets and variables -> Actions -> New
   repository secret**.
2. Name: `TAURI_SIGNING_PRIVATE_KEY`. Value: the whole contents of the
   private key file (one long line of letters).
3. Only if the key has a password: a second secret,
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Kessel's key (made with `--ci`) has none.

That's all. The next release (`.github/workflows/release.yml`) signs the
installers, adds a `.sig` for each, and publishes `latest.json`. Without the
secret, releases still work, but they have no `latest.json` and installed
copies don't hear about them (the run shows a warning).

### Making a new key

Only if the key is lost or leaked:

```
cd tauri-browser
npx.cmd --yes @tauri-apps/cli@2 signer generate --ci -w kessel-updater.key
```

Put the contents of `kessel-updater.key.pub` in `plugins.updater.pubkey`,
the contents of `kessel-updater.key` in the `TAURI_SIGNING_PRIVATE_KEY`
secret, and delete both files from the folder. Copies of Kessel with the old
public key must be updated by hand once.

## Releasing

As before (see the top of `release.yml`): bump the version in
`tauri-browser/package.json`, `src-tauri/tauri.conf.json` and
`src-tauri/Cargo.toml`, add `.github/release-notes/v<version>.md`, and push
the tag. The notes' text becomes the update's "What's new".

Kessel only offers a version newer than its own. Copies older than the first
release with the updater (v0.10.0 and before) have no updater, so they need
that one release installed by hand.

Pre-releases are skipped: `releases/latest` is the newest full release.
