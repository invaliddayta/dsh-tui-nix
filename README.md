# DeepSeek Harness TUI

Nix package for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) terminal UI ([dsh-tui](https://github.com/dsh-tui/dsh-tui)), built from pinned source revisions. The Harness Web app, browser client packages, alternate model-provider SDKs, telemetry exporter, and browser RPC gateway are not included.

This is an independent packaging project. DeepSeek Harness and dsh-tui are owned and maintained by their upstream projects.

## Run

Supported systems: `x86_64-linux`, `aarch64-linux`. You need [Nix](https://nixos.org/download/) with `nix-command` and `flakes` enabled, and `DEEPSEEK_API_KEY` set in your environment.

```sh
nix run github:invaliddayta/dsh-tui-nix
```

The first run builds from source and takes a while. No pnpm or Node.js installation is required at runtime.

Inside the TUI, `/model` opens the model selector and `/model <model-id>` switches directly. The packaged DeepSeek provider offers `deepseek-v4-flash`, `deepseek-v4-pro`, and `deepseek-v4-flash-vision-exp`.

## Profile

The launcher manages `$DSH_HOME/profiles/deepseek-harness-tui` (`~/.dsh/profiles/deepseek-harness-tui` if `DSH_HOME` is unset). Edit `cordis.patch.yml` in that directory to override the packaged profile.

After a package update, the launcher warns if its managed profile files are stale. To refresh them while keeping your `cordis.patch.yml`:

```sh
DSH_TUI_RESET_PROFILE=1 nix run github:invaliddayta/dsh-tui-nix
```

The reset refuses to touch a profile that was not created by this package.

## Scope

Included: terminal UI, DeepSeek provider, image-aware local coding tools, sandbox launchers, session persistence, subagents, workflows, DeepSeek-backed Web search.

Excluded: Harness Web app and its host packages, browser-only client packages, alternate-provider SDKs, OpenTelemetry exporter, browser RPC gateway, the generic `dsh` executable.

Session telemetry is disabled by default. The agent can run model-generated commands and modify files; read the upstream [safety notice](https://github.com/deepseek-ai/deepseek-harness/blob/76fda729799fe9b3848dbe2c211d4b231032b81e/SAFETY.md) first.

## Maintenance

`flake.lock` pins Nixpkgs and both upstream source trees. Bumping the DeepSeek Harness input can change the pnpm store hash in `nix/package.nix` and requires a full rebuild on both architectures. When upstream changes its CLI or base bundle, review `CLI_RUNTIME_PACKAGES`, `FORBIDDEN_PACKAGES`, and `OMITTED_BASE_ROWS` in `nix/project-tui-runtime.mjs`.

```sh
nix flake check --no-build --all-systems
nix flake check --max-jobs 1 --cores 2
```

The build checks include the packaged PTY smoke test, regressions for premature
child exits, a type check against the exact packaged Harness peers, and focused
question-answering, cancellation, and session-resume tests. CI runs them on both
supported architectures.

The session compatibility patch uses validated query-service log reads for resume
titles and last-event timestamps. Reads are concurrency-limited; browsing a large
history can take longer than a metadata-only scan.

## License

The packaging code is [MIT](LICENSE). The built output contains upstream and third-party software under their own licenses; those license files and the DeepSeek Harness third-party notice are installed under `share/licenses/deepseek-harness-tui`.
