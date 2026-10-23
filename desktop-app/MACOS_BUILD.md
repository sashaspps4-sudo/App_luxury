# macOS build

Status: implementation and build pipeline prepared. No macOS artifact has been
built or tested in this Windows workspace. Do not describe a build as verified
until the macOS jobs and the interactive checks below pass.

## What is included

- macOS 14+ (matching the supported Playwright runtime).
- Separate Apple Silicon and Intel packages. Runtime architecture must match the
  Rust app; universal/cross builds deliberately fail rather than mix binaries.
- AES-256-GCM protected license/proxy files. The random master key is stored in
  the user's macOS login Keychain, created with add-only semantics so simultaneous
  processes cannot replace an existing master key. Authentication errors never
  fall back to plaintext. Windows continues using DPAPI. Windows session/profile
  files cannot be transferred to macOS; sign in and add proxies on the Mac.
- Bundled Node.js, Chromium, and a frozen Python provider executable. The friend
  does not need Node/Python/pip or a source checkout on the destination Mac.
- Generated ICNS icon, .app and .dmg packaging, and a manual GitHub Actions build
  for both processor architectures.

## Build on a Mac

Install Apple's command-line build tools, Rust stable, an official Node.js 22
binary, and Python 3.12 of the same processor architecture. A Homebrew-linked
Node binary is rejected if it depends on dylibs outside macOS system locations.

From `desktop-app`:

```sh
npm ci
npm run macos:build
```

The preparation script creates a private build venv, freezes only the EQL and
KARTATAI provider modules with their category JSON, installs locked runtime npm
dependencies and matching Chromium, creates the icon, then smoke-tests the
embedded provider and browser. No API keys, proxies, licenses or user profiles
are collected from the machine into the package.

Artifacts appear under
`src-tauri/target/<architecture>-apple-darwin/release/bundle/dmg/`.

The generated `src-tauri/macos-runtime` directory is disposable and excluded
from version control; only that verified directory is cleaned during rebuilds.

## Build in GitHub Actions

Put the project into a GitHub repository with `.github/workflows/macos-build.yml`.
Run **macOS desktop build** manually in Actions. It builds on macos-15 (ARM) and
macos-15-intel (Intel), runs native tests, verifies embedded runtimes, and exposes
separate DMGs as artifacts. The workflow does not publish a release or send files.
Private repository jobs may consume the repository owner's Actions minutes.

## Signing

The current configuration is an **ad-hoc signed development distribution**, not
an Apple Developer ID signed/notarized release. Gatekeeper can warn or refuse
launch after transfer. Do not market it as a warning-free signed installer.
For a public release, configure Developer ID signing and notarization, including
all embedded executables. The current hardened-runtime=false setting is for the
ad-hoc development package; a hardened/notarized distribution needs a separate
entitlements/signing review and tests for Node JIT and the frozen provider.

## Required checks on a real Mac

1. Install from the DMG into Applications; launch through Finder.
2. Activate, allow Keychain access if prompted, quit and reopen. Confirm license
   and proxy persistence. Run the ignored Keychain roundtrip test in a disposable
   macOS user account; it accesses the app's actual Keychain master-key entry:
   `cargo test --manifest-path src-tauri/Cargo.toml keychain_persists_one_key_and_roundtrips -- --ignored`.
3. Verify the app works without a terminal's Node/Python on PATH. Confirm direct
   and SOCKS5 browser profiles launch and close correctly.
4. With a controlled test mailbox and listings, verify provider-link generation,
   outgoing text/HTML, reply verification, counters, cancellation and retries.
5. Repeat on both Apple Silicon and Intel before distributing both variants.

Automation verifies executable architecture, provider imports, Chromium launch,
and bundle signature integrity. These checks cannot establish that live Gmail
selectors, proxy access, Keychain permissions and Apple signing all work.

References: [Tauri resources](https://v2.tauri.app/develop/resources/),
[Tauri macOS bundles](https://v2.tauri.app/distribute/macos-application-bundle/),
[Playwright system requirements](https://github.com/microsoft/playwright.dev/blob/main/nodejs/docs/intro.mdx),
[PyInstaller macOS packaging](https://pyinstaller.org/en/stable/usage.html),
[GitHub macOS runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners),
[RustCrypto AES-GCM](https://docs.rs/aes-gcm/0.10.3/aes_gcm/).
