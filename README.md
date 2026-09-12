# DeepSeek Harness TUI

Nix package for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) terminal UI ([dsh-tui](https://github.com/dsh-tui/dsh-tui)), built from pinned source revisions. Includes the direct DeepSeek provider, the upstream Pi multi-provider plugin, and in-app provider setup. The frontend remains Pi-TUI: no React, React reconciler, Harness Web app, browser client packages, telemetry exporter, or browser RPC gateway.

This is an independent packaging project. DeepSeek Harness and dsh-tui are owned and maintained by their upstream projects.

## Run

Supported systems: `x86_64-linux`, `aarch64-linux`. You need [Nix](https://nixos.org/download/) with `nix-command` and `flakes` enabled. You can launch without an API key and use `/provider` to sign in. `DEEPSEEK_API_KEY` still configures the default direct DeepSeek route.

```sh
nix run github:invaliddayta/dsh-tui-nix
```

The first run builds from source and takes a while. No pnpm or Node.js installation is required at runtime.

The package includes its own Harness runtime; you do not need a separate DeepSeek
Harness installation. Reusing another harness's credentials is optional and has
an [existing-installation prerequisite](#opencode-owned-credentials). Otherwise,
use DSH's native `/provider` sign-in without installing OpenCode.

Inside the TUI, `/model` opens the model selector and `/model <provider>/<model-id>` switches directly. An unambiguous model ID also works without the provider prefix. The direct DeepSeek provider (`deepseek-official`) offers `deepseek-v4-flash`, `deepseek-v4-pro`, and `deepseek-v4-flash-vision-exp`.

**Ctrl+T** at the chat prompt cycles the current model's advertised reasoning efforts, without reopening `/model` or submitting your draft. The chosen effort appears beside the model name and applies to new steps, not an already-running request. For Grok 4.6 the cycle is Default, Low, Medium, High, Xhigh, then Default again. Default leaves the effort unspecified; it does not disable reasoning. Inside `/model`, Ctrl+T previews the highlighted model's effort and Enter applies it. Kitty key-release and repeat events are ignored, so a press advances once. Accepted model and effort selections also become the global startup default; previews and cancelled selections do not. Ctrl+R only shows or hides reasoning text.

## Other Providers

The bundled [`@deepseek-ai/dsh-llm-pi-ai`](https://github.com/deepseek-ai/deepseek-harness/blob/76fda729799fe9b3848dbe2c211d4b231032b81e/packages/llm/llm-pi-ai/README.md) adapter supports Pi's provider catalog and custom OpenAI-compatible endpoints. It starts dormant: only providers you configure add models to the picker. There is no separate plugin installation or background gateway to run.

Run `/provider` inside the TUI:

- **Sign in** lists the installed provider catalog, then the login methods that provider actually supports. Enter an API key in a masked prompt or complete a supported browser/subscription login. On success, the provider is enabled and you can open `/model` immediately.
- **Configure endpoints** runs the reused upstream wizard to add, edit, or remove settings, discover models, and configure custom OpenAI/Anthropic-compatible servers. An empty key on a new custom endpoint stores the placeholder `local` for Pi's compatible client.
- **Sign out** removes a native sign-in credential and disables that provider's user-configured route. It leaves environment variables and separate API-key references untouched, and refuses to disable a composition-base route.

Type to filter lists, use arrows and Enter to choose, Space to toggle multiple models, Tab for custom input where offered, and Escape to cancel. Long details and authorization URLs scroll with Page Up/Page Down. Browser login uses the host's `xdg-open`; if it is unavailable, open the displayed URL yourself. Press `O` in the waiting panel to open it again.

The pinned catalog exposes 39 login flows. OAuth methods are currently advertised for Anthropic, GitHub Copilot, Kimi Coding, OpenAI Codex, OpenRouter, and xAI. Availability is determined by the installed provider implementation, not a promise that every subscription supports third-party login. Live account login requires your account and network access; automated tests do not exercise real OAuth endpoints.

Secrets and login codes are entered through private overlays, not agent tools or chat messages. They are masked even during paste and resize. For native sign-in, Harness owns credential storage and refresh: `$DSH_HOME/.credentials.yaml` (`~/.dsh/.credentials.yaml`), with private file permissions. Settings contain provider configuration and credential references, not the entered secrets. Native sign-in replaces that provider's stored credential and removes its user `apiKeyEnv` override after confirmation; unrelated settings survive. Credentials and settings are separate writes: if enabling a route fails after login, the credential can remain stored for a retry.

### Model Catalog Updates

All built-in Pi providers use the catalog shipped with **Pi-AI 0.85.1**, including Z.ai's `glm-5.3-flash` (image input, 1M context) and OpenAI's `gpt-6-astra`. The same catalog feeds `/model` and the provider wizard. After upgrading this package, restart the TUI; no sign-out, credential replacement, or profile reset is needed. For Z.ai, select `/model zai/glm-5.3-flash`.

Built-in discovery is an offline catalog lookup, not a live refresh from each vendor. Reproducible builds pin this catalog together with the matching provider SDK and adapter; future model releases require a package update. Custom endpoints can use the wizard's network discovery or manual model entry. A user-configured `models` list deliberately replaces the built-in selection and stays unchanged on upgrade: reselect models in **Configure endpoints**, or remove only that provider's `models` field to follow the full bundled catalog. Account and subscription access still depend on the provider.

### Manual Configuration

Alternatively, add providers to `$DSH_HOME/settings.yaml` (`~/.dsh/settings.yaml` by default), merging with existing settings:

```yaml
llm-pi-ai:
  providers:
    openai:
      apiKeyEnv: OPENAI_API_KEY
    anthropic:
      apiKeyEnv: ANTHROPIC_API_KEY
    google:
      apiKeyEnv: GEMINI_API_KEY
    openrouter:
      apiKeyEnv: OPENROUTER_API_KEY
```

These are environment-variable names, not API keys. Set the corresponding keys before launching the TUI; configuring a route alone does not authenticate it. Settings are hot-reloaded. Open `/model` again to see the configured providers, or select a model directly, for example `/model anthropic/claude-sonnet-4-5`. Available models come from the pinned Pi catalog; a provider's `models` list can replace that catalog when you need a newer or smaller selection.

Custom gateways and local servers need an endpoint, protocol, and explicit model list. For example, add this route under the same `llm-pi-ai.providers` mapping:

```yaml
local:
  api: openai-completions
  baseURL: http://127.0.0.1:11434/v1
  apiKeyEnv: LOCAL_LLM_API_KEY
  models:
    - id: your-installed-model
      contextWindow: 32768
      maxTokens: 4096
```

Use the model ID and limits your server actually supports. Pi's OpenAI-compatible client requires a credential even for a keyless local server; set `LOCAL_LLM_API_KEY=local` in that case. Select it with `/model local/your-installed-model`.

Fresh sessions use the last model explicitly selected with `/model` (including an
accepted picker selection and reasoning effort). It is stored in the existing
`agent-default-model` section of `$DSH_HOME/settings.yaml`, globally across projects
and profiles sharing that harness home. A resumed session keeps its last recorded
request's model; merely resuming or closing it does not change the global preference.
Concurrent sessions use the last successfully saved explicit selection, not the
last session to exit. Invalid model commands and cancelled previews do not save.
If saving fails, the current session still changes and the TUI shows a warning.

Without a saved preference, the profile's configured startup model remains the
fallback. To configure that fallback and the shared agent default, add these
overrides to the profile's `cordis.patch.yml` (see below):

```yaml
- id: agent-default-model
  config:
    provider: anthropic
    model: claude-sonnet-4-5
- id: agent-loop
  config:
    agents:
      - id: main
        provider: anthropic
        model: claude-sonnet-4-5
        cwd: !!js process.cwd()
```

A saved `agent-default-model` user setting takes precedence over these fallback
values; remove only that section from `settings.yaml` to return to the configured
fallback. The provider must also be configured (in-app sign-in does this automatically).
Remembering a model does not configure its credentials or silently switch to a
different provider if it becomes unavailable; use `/provider` or `/model` to resolve
that explicitly. DeepSeek-backed Web search still needs `DEEPSEEK_API_KEY`; selecting
another chat provider does not replace that tool's backend.

### OpenCode-Owned Credentials

The optional [`dsh-credentials-opencode`](packages/credentials-opencode/README.md)
plugin reuses OpenCode's API keys and compatible OAuth grants without copying them
into Harness. It is a separate package with no TUI dependencies, bundled but not
enabled by default. It maps full Harness credential-record addresses to OpenCode
provider IDs.

**Prerequisite: your credential-owning harness must already be set up.** This
bridge currently supports **OpenCode only**, not arbitrary preferred harnesses.
Install/configure OpenCode and sign in to the providers you want to reuse before
enabling the bridge. The OpenCode credential store must be accessible to the user
running DSH on that machine. Installing this package does not install OpenCode,
create its credentials, import its provider settings, or synchronize credentials
from another computer.

OpenCode does not need to be running while DSH reads existing credentials, but you
still need access to it for sign-in and OAuth refresh. DSH does not invoke its CLI
or refresh externally owned grants automatically. Without an existing OpenCode
setup, leave this bridge disabled and use native `/provider` sign-in instead.

After those prerequisites are met, add the following profile patch:

```yaml
- id: credentials
  disabled: true
- insert:
    - id: opencode-credentials
      name: 'dsh-credentials-opencode'
      config:
        records:
          llm-pi-ai/openai-codex: { provider: openai, type: oauth }
          llm-pi-ai/xai: { provider: xai, type: oauth }
          llm-pi-ai/kimi-coding: { provider: kimi-for-coding, type: api }
          llm-pi-ai/qwen-token-plan: { provider: alibaba-token-plan, type: api }
          llm-pi-ai/deepseek: { provider: deepseek, type: api }
        refs:
          DEEPSEEK_API_KEY: deepseek
```

The original entry must be disabled and the bridge inserted under a new ID.
In loader patches, `name` is a match guard, not a replacement field: changing
the existing `credentials` entry's name skips the entire patch. Restart DSH after
changing the credential service composition.

Enable the corresponding routes in `settings.yaml` as usual, without `apiKeyEnv`
for record-backed routes. The optional `refs` mapping also supplies the direct
DeepSeek provider and its Web search tool. Explicit process environment values
still take precedence for references. Unbound native credentials work normally.

The bridge reads `$XDG_DATA_HOME/opencode/auth.json` (normally
`~/.local/share/opencode/auth.json`) on each operation; `authPath` overrides this
location. The file must belong to the current user and have owner-only permissions.
Bound records remain read-only even after an OpenCode sign-out, so stale Harness
credentials cannot silently take over. Only explicitly bound providers are read.

The provider UI shows the credential owner and safe per-provider diagnostics for
missing, invalid, expired, or unreadable credentials. A broken binding does not
hide healthy providers. Request-time reads still fail closed; enumeration never
falls back to stale native records for externally owned addresses.

To migrate the earlier distribution-local bridge, change the plugin name from
`@dsh-tui/providers/lib/opencode-credentials.js` to `dsh-credentials-opencode` and
prefix each `records` key with `llm-pi-ai/`. Leave `refs` and model settings alone.
There is no credential-file migration or token copying.

**OpenCode owns sign-in and OAuth refresh.** DSH refuses token-refresh callbacks,
credential replacement, and sign-out for these bindings; it never writes to the
OpenCode store or invokes a refresh that could invalidate OpenCode's token.
Refresh/sign in through OpenCode and retry when an OAuth grant expires (Pi requests
refresh within five minutes of expiry). Unexpired OpenAI Codex, Anthropic, and xAI
grants have compatible payloads, but account access and provider-specific request
policies still apply. OpenCode plugins, model aliases, and request options are not
automatically imported.

Provider names alone do not guarantee endpoint equivalence: Pi's `zai` catalog
defaults to the Coding Plan URL, unlike OpenCode's standard `zai` route. Bind keys
only after matching endpoint and protocol; keep standard and subscription routes
separate. This bridge is opt-in and does not change the packaged default profile.

## Profile

The launcher manages `$DSH_HOME/profiles/deepseek-harness-tui` (`~/.dsh/profiles/deepseek-harness-tui` if `DSH_HOME` is unset). Edit `cordis.patch.yml` in that directory to override the packaged profile.

After a package update, the launcher warns if its managed profile files are stale. To refresh them while keeping your `cordis.patch.yml`:

```sh
DSH_TUI_RESET_PROFILE=1 nix run github:invaliddayta/dsh-tui-nix
```

The reset refuses to touch a profile that was not created by this package.

## Scope

Included: Pi-TUI terminal UI, native in-app API-key/OAuth authorization, upstream provider-settings wizard, optional read-only OpenCode credential plugin, direct DeepSeek provider, Pi multi-provider adapter and its provider SDK dependencies, image-aware local coding tools, sandbox launchers, session persistence, subagents, workflows, DeepSeek-backed Web search.

Excluded: Harness Web app and its host packages, browser-only client packages, OpenTelemetry exporter, browser RPC gateway, the generic `dsh` executable. Provider SDK dependencies include HTTP libraries and the OpenTelemetry API; these do not restore the excluded Harness services or a telemetry exporter.

Session telemetry is disabled by default. The agent can run model-generated commands and modify files; read the upstream [safety notice](https://github.com/deepseek-ai/deepseek-harness/blob/76fda729799fe9b3848dbe2c211d4b231032b81e/SAFETY.md) first.

## Maintenance

`nix/harness-credential-ownership.patch` is a small, UI-independent Harness change:
optional credential ownership/diagnostic metadata and a read-only preflight in
the shared authorization service. It preserves per-key exclusion and cancellation
while checking metadata. Remove it once the pinned Harness includes these changes.
`packages/credentials-opencode` is built separately and only depends on Harness
credential peers; the TUI reads generic metadata, not OpenCode-specific APIs.
Tests cover malformed-store isolation, non-Pi record scopes, direct authorization
callers, and the documented profile through the actual loader and HTTP boundary.

`flake.lock` pins Nixpkgs and both upstream source trees. Bumping the DeepSeek Harness input can change the pnpm store hash in `nix/package.nix` and requires a full rebuild on both architectures. When upstream changes its CLI or base bundle, review `CLI_RUNTIME_PACKAGES`, `FORBIDDEN_PACKAGES`, and `OMITTED_BASE_ROWS` in `nix/project-tui-runtime.mjs`.

`nix/build-runtime.mjs` uses that single projected workspace list for TypeScript and the upstream host bundler. `nix/harness-host-build.patch` makes the shared upstream preset emit the selected packages' Node halves during the host pass; there is no separate fallback bundler or browser pass. Remove this patch when upstream supports a Node-only build of these packages. Installation checks require the selected Node entry points and reject their browser bundles.

The distribution owns packaging and default composition, not alternate implementations of Harness services. Keep source pins as a tested pair; remove compatibility patches only after session, provider, and terminal regressions pass. The current frontend still targets older Harness APIs, so upgrading Harness alone is not a compatibility cleanup. Keep the session adaptations until a compatible frontend is available, and test persisted-session migrations separately from packaging refactors.

`nix/package.nix` also pins two upstream Harness backports: [`69a0441`](https://github.com/deepseek-ai/deepseek-harness/commit/69a0441c34019fbb416db35eec0a48470391ddd7) upgrades Pi-AI and its dependency lock to 0.85.1, and [`7bab91d`](https://github.com/deepseek-ai/deepseek-harness/commit/7bab91d247e4a7a2e84c68e1883359f5dc718e6a) preserves Anthropic replay identity. They are hash-checked patches limited to the adapter and dependency files, not locally maintained model tables. Remove these backports when the Harness input includes them. Catalog updates must keep the SDK and adapter compatible; the build runs the upstream catalog/compatibility/replay tests and checks every nonempty provider catalog through the installed model-list and discovery services.

`nix/providers.nix` separately pins the MIT-licensed wizard from [ccch1mneyyy/dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI/tree/9639f69b4cb2c3907844160094515e3970b55c8b). The build copies its React-free wizard and helpers and extracts its provider-host method by TypeScript syntax. It does not build or install that project's UI or dependencies. Local code bridges private Pi-TUI dialogs and Harness's native `authorization` service; no separate `dsh-auth` plugin or second OAuth store is needed. A small widget export shares our existing bundled Pi-TUI implementation rather than bundling another copy.

Provider TypeScript sources and the wizard verification script stay in build-time check material, outside the installed runtime package. The runtime retains compiled JavaScript, type declarations, and licenses; the checks still type-check and exercise the extracted sources. The build-only virtual-address cap is restored to the caller's original limit before runtime install checks; Node heap and worker limits remain enforced.

`nix/tui-command-history.patch` honors Harness's `recordInput: false` at the editor boundary, so rejected `/provider` arguments are not retained in prompt history. Remove it when the frontend honors that flag itself. Tests submit commands through the editor and verify both history and session events, rather than testing only direct command-service calls.

Deployment excludes pnpm installation-state files containing wall-clock timestamps and temporary store paths. Use `nix build .#default --rebuild --no-link` to check that a fresh build matches an existing output byte-for-byte.

```sh
nix flake check --no-build --all-systems
nix flake check --max-jobs 1 --cores 2
```

The build checks include the packaged PTY smoke test, regressions for premature
child exits, a type check against the exact packaged Harness peers, and focused
question-answering, cancellation, session-resume, and offline multi-provider
registration tests, private-dialog masking/paste/resize checks, native authorization
and credential-persistence tests, and the upstream wizard regression suite. CI runs them on both
supported architectures.

The session compatibility patch uses validated query-service log reads for resume
titles and last-event timestamps. Reads are concurrency-limited; browsing a large
history can take longer than a metadata-only scan.

## License

The packaging code is [MIT](LICENSE). The built output contains upstream and third-party software under their own licenses; those license files and the DeepSeek Harness third-party notice are installed under `share/licenses/deepseek-harness-tui`.
