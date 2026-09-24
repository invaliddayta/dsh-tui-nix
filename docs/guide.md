# Guide

[Back to README](../README.md)

## Getting started

Supported systems are `x86_64-linux` and `aarch64-linux`. You need [Nix](https://nixos.org/download/) with the `nix-command` and `flakes` features enabled.

```sh
nix run github:invaliddayta/dsh-tui-nix
```

The first run builds from source and takes a while. The package contains its own Harness runtime, so you don't need Node.js, pnpm or a separate Harness install. You can start without an API key and sign in with `/provider`; `DEEPSEEK_API_KEY` still configures the direct DeepSeek route.

## Models and reasoning effort

`/model` opens the model picker. `/model <provider>/<model-id>` switches directly, and the provider prefix can be left out when the model ID is unambiguous. The direct DeepSeek provider (`deepseek-official`) offers `deepseek-v4-flash`, `deepseek-v4-pro` and `deepseek-v4-flash-vision-exp`.

Ctrl+T at the prompt cycles through the reasoning efforts the current model advertises, without touching your draft. For Grok 4.6 that is Default, Low, Medium, High, Xhigh and back to Default. Default leaves the effort unset; it doesn't turn reasoning off. The effort is shown next to the model name and applies from the next step. Inside `/model`, Ctrl+T previews the effort for the highlighted model and Enter applies it. Ctrl+R only shows or hides reasoning text.

The model and effort you accept in `/model` become the default for new sessions, across all projects that share the same `$DSH_HOME`. They're saved in the `agent-default-model` section of `$DSH_HOME/settings.yaml`. Previews, cancelled picks and invalid commands don't save anything. A resumed session keeps the model its last request used. If several sessions are open, the last successful save wins. If saving fails, the current session still switches and you get a warning.

Without a saved choice, the profile's startup model is used. To change that fallback, add this to your profile's `cordis.patch.yml` (see [Profile](#profile)):

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

A saved choice in `settings.yaml` takes precedence; delete that section to go back to the fallback. The provider still has to be configured, and an unavailable remembered model is never silently swapped for another one.

## Images

Pick a model that accepts images first, for example `/model deepseek-official/deepseek-v4-flash-vision-exp` (DeepSeek credentials) or `/model zai/glm-5.3-flash` (Z.ai credentials). The default `deepseek-v4-pro` is text-only.

| Input | Result |
| --- | --- |
| Ctrl+V | Pastes the clipboard image using `wl-paste` (Wayland) or `xclip` (X11). Both are bundled, but versions on your `PATH` are used first. A text clipboard pastes as text. |
| Drop a file on the terminal | A paste that consists only of existing image paths (quoted, escaped or `file://`) is attached instead of inserted. |
| `/image <path>` | Attaches one file. Relative paths are resolved from the session directory. |

Each image shows up in the prompt as a placeholder like `[image #1 (1920×1080)]`. Write around it and press Enter; text and images reach the model in the order you wrote them. Deleting the placeholder removes the image.

Before sending, the TUI checks the selected model. If it only accepts text, the message is refused and your draft is restored. Harness validates, downscales and stores accepted images before the request goes out. Messages with images are left out of prompt history, since a recalled placeholder would have no image behind it. In the transcript, images appear as labels such as `[image screenshot.png 1920×1080]`; they aren't rendered inline.

The agent can also open image files itself with the `read_image` tool, for example: `Use read_image on ./screenshot.png and explain the error shown.` PNG, JPEG, WebP and GIF are supported, including files without an extension. Sandbox permissions apply.

For custom Pi-compatible endpoints, unknown models are treated as text-only. Add `input: ["text", "image"]` to the model entry in your `llm-pi-ai` settings only if the server really accepts images; the provider wizard doesn't set this.

## Resume a conversation

`/resume` lists saved sessions from the current workspace; Tab shows all workspaces. Picking one restarts the TUI in that session's workspace. Rows appear as their titles load, and a session whose log can't be read shows up as a disabled "Unreadable session" row. Only the session you pick is fully loaded and checked, and its model route must still be available.

Titles are cached in `$DSH_HOME/tui/resume-titles.json`, keyed by each log's revision, so an unchanged session is never read again just for its title. The file is only readable by you and safe to delete. Set `DSH_TUI_RESUME_TITLE_CACHE=off` to disable it, or to a file path to move it.

## Fork a conversation

`/fork` copies the current conversation into a new session and switches to it. The original stays as it was. The new session gets its own ID, shows up in `/resume`, and shows its parent when opened. No model request is made.

```text
/fork
/fork --through-turn 3
```

By default the fork includes everything up to the last finished turn, along with settings changed between turns. `--through-turn N` stops after turn `N`. `N` is the turn number in the log, not a message index, and cancelled or failed turns count. An unfinished turn at the end is never included. Finish or cancel running work before forking. Empty conversations and turn numbers that don't exist or haven't finished are refused.

Only the conversation is copied. Both sessions work in the same directory on the same files. `/fork` needs session persistence and the same host support as `/resume`. If switching fails after the new session was written, the TUI prints its ID so you can open it with `/resume`.

## Providers

The bundled [`@deepseek-ai/dsh-llm-pi-ai`](https://github.com/deepseek-ai/deepseek-harness/blob/76fda729799fe9b3848dbe2c211d4b231032b81e/packages/llm/llm-pi-ai/README.md) adapter gives access to Pi's provider catalog and to custom OpenAI-compatible endpoints. Only providers you configure add models to the picker.

`/provider` has three options:

- **Sign in** lists the providers and the login methods each one supports. Enter an API key in a masked prompt or complete a browser login. The provider is enabled right away.
- **Configure endpoints** runs the provider wizard from [ccch1mneyyy/dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI) to add, edit or remove providers, discover models, and set up custom OpenAI- or Anthropic-compatible servers. Leaving the key empty for a new custom endpoint stores the placeholder `local`.
- **Sign out** deletes the stored credential and disables the route you configured. Environment variables and API key references are left alone. If your profile patch enables the route, it stays enabled.

In these dialogs, type to filter, use the arrow keys and Enter to choose, Space to toggle models, Tab for custom input where offered, and Escape to cancel. Page Up and Page Down scroll long text. Browser login opens the URL with `xdg-open`; if that fails, open it yourself. Press `o` in the waiting panel to open it again.

The pinned catalog (Pi-AI 0.86.1) has 41 provider routes. Browser login is offered for Anthropic, GitHub Copilot, Kimi Coding, Meta, OpenAI Codex, OpenRouter, Radius and xAI. Whether your subscription allows logins from third-party tools is up to the provider.

Keys and login codes go through private dialogs, never through the chat or agent tools, and stay masked while pasting or resizing. Harness stores them in `$DSH_HOME/.credentials.yaml` with owner-only permissions and handles refreshing them. `settings.yaml` only holds provider settings and references to credentials. Signing in again replaces the stored credential for that provider and, after asking, removes its `apiKeyEnv` override. The credential and the settings are written separately, so if enabling the provider fails after a login, the credential stays saved for the next attempt.

### Model catalog

Built-in providers use the catalog shipped with Pi-AI 0.86.1. It includes Z.ai's `glm-5.3-flash` (image input, 1M context), OpenAI's `gpt-6-astra`, DeepSeek's `deepseek-flash`, and the Meta and Radius routes. `/model` and the wizard use the same catalog. After updating the package, restart the TUI; you don't have to sign in again or reset your profile.

The catalog is pinned at build time, so new models arrive with package updates. For custom endpoints the wizard can discover models over the network, or you can list them by hand. A `models` list you set for a provider replaces the built-in selection and survives updates. To follow the bundled catalog again, remove that provider's `models` field or reselect models in **Configure endpoints**.

### Manual configuration

You can also add providers to `$DSH_HOME/settings.yaml` (default `~/.dsh/settings.yaml`):

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

The values are names of environment variables, not keys, so set those variables before starting the TUI. Settings reload automatically; open `/model` again or switch directly, for example `/model anthropic/claude-sonnet-4-5`.

A local server or custom gateway needs an endpoint, a protocol and a model list. Add it under the same `providers` key:

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

Use the model ID and limits your server supports. Pi's OpenAI-compatible client wants a key even when the server doesn't, so set `LOCAL_LLM_API_KEY=local`. Then select `/model local/your-installed-model`.

The web search tool always uses DeepSeek and needs `DEEPSEEK_API_KEY`, whichever model you chat with.

### OpenCode credentials

The optional [`dsh-credentials-opencode`](../packages/credentials-opencode/README.md) plugin lets Harness use the API keys and logins OpenCode already has, without copying them. It's bundled but disabled by default.

It only works with OpenCode, and OpenCode has to be installed and signed in to the providers you want on the same machine and user account. The plugin doesn't install OpenCode or create, import or sync credentials. OpenCode doesn't need to be running, but you still use it to sign in and to refresh logins. If you don't use OpenCode, use `/provider` instead.

To enable it, add this to your profile patch:

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

The stock `credentials` entry has to be disabled and the plugin inserted under a new ID. Changing the `name` of the existing entry doesn't work: in loader patches `name` only guards the match, so the whole patch would be skipped. Restart after changing it.

Then enable the providers in `settings.yaml` as usual, without `apiKeyEnv` for the ones listed under `records`. The `refs` entry also supplies the direct DeepSeek provider and web search. A variable set in the environment still takes precedence. Credentials that aren't mapped keep working normally.

The plugin reads `$XDG_DATA_HOME/opencode/auth.json` (usually `~/.local/share/opencode/auth.json`) on every access; set `authPath` to use another file. The file must belong to you and be readable only by you. Only the mapped providers are read. Mapped entries are read-only: DSH won't refresh, replace or sign out of them, and never writes to OpenCode's file, so it can't invalidate OpenCode's tokens. When a login expires (Pi refreshes five minutes before expiry), sign in again in OpenCode and retry. OpenCode's plugins, model aliases and request options aren't imported.

`/provider` shows which credentials OpenCode owns and why one isn't usable (missing, invalid, expired or unreadable). A broken mapping doesn't hide the other providers, and requests never fall back to an old credential stored by Harness.

Matching names don't mean matching endpoints. Pi's `zai` provider points at the Coding Plan URL, while OpenCode's `zai` is the standard API. Only map a key after checking that endpoint and protocol match.

If you used the earlier bridge that shipped inside this package, change the plugin name from `@dsh-tui/providers/lib/opencode-credentials.js` to `dsh-credentials-opencode` and add the `llm-pi-ai/` prefix to each `records` key. Nothing else changes.

## Profile

The launcher manages the profile in `$DSH_HOME/profiles/deepseek-harness-tui` (`~/.dsh/profiles/deepseek-harness-tui` by default). Put your changes in `cordis.patch.yml` there.

After a package update the launcher warns if its own profile files are out of date. To refresh them without touching your `cordis.patch.yml`:

```sh
DSH_TUI_RESET_PROFILE=1 nix run github:invaliddayta/dsh-tui-nix
```

The reset refuses to touch a profile this package didn't create.

## What's included

The package contains the Pi-TUI frontend, in-app API key and browser sign-in, the provider wizard, the optional OpenCode credential plugin, the direct DeepSeek provider, the Pi multi-provider adapter, prompt image input, the local coding tools, sandbox launchers, session persistence with `/resume` and `/fork`, subagents, workflows, and DeepSeek web search.

It leaves out the Harness web app and its host packages, browser-only client packages, the OpenTelemetry exporter and the browser RPC gateway. The Harness CLI is only used internally by `dsh-tui`, so there is no `dsh` command on your `PATH`. Some provider SDKs pull in HTTP libraries and the OpenTelemetry API, but nothing exports telemetry, and session telemetry is off by default.

The agent runs commands and edits files. Read the upstream [safety notice](https://github.com/deepseek-ai/deepseek-harness/blob/76fda729799fe9b3848dbe2c211d4b231032b81e/SAFETY.md).

## Maintenance

### Pins

`flake.lock` pins Nixpkgs, DeepSeek Harness, dsh-tui and [XMoon/dsh-pi-tui](https://github.com/XMoon/dsh-pi-tui/tree/792c7ec19d1e7c554e67931573e79a7ef72bc617). `nix/providers.nix` pins the wizard from [ccch1mneyyy/dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI/tree/9639f69b4cb2c3907844160094515e3970b55c8b) by hash.

Bumping Harness can change the pnpm store hash in `nix/package.nix` and needs a full rebuild on both architectures. If upstream changes its CLI or base bundle, review `CLI_RUNTIME_PACKAGES`, `FORBIDDEN_PACKAGES` and `OMITTED_BASE_ROWS` in `nix/project-tui-runtime.mjs`. `nix/build-runtime.mjs` builds exactly that package list with TypeScript and the upstream host bundler.

The pinned dsh-tui targets an older Harness API, so Harness and dsh-tui have to be bumped and tested together. Only drop a compatibility patch once the session, provider and terminal tests pass without it, and test session migrations separately from packaging changes.

From dsh-pi-tui, the build copies eight modules from `src/image/` unchanged: types, errors, placeholder, draft store, intake, admission, capability and clipboard. None of its UI, its Pi-TUI fork or its dependencies are built. From the wizard project, the build copies the wizard and its helpers and extracts the provider host method by TypeScript syntax; its UI isn't built either. The provider code talks to Harness's own `authorization` service, so there is no second OAuth store, and it reuses the bundled Pi-TUI through a small `provider-widgets` export.

### Carried patches

Every patch applies with `--fuzz=0`. When a pin bump breaks one, regenerate it against the new source. Delete each patch once upstream has the change.

| Patch or copied file | Target | Purpose |
| --- | --- | --- |
| `harness-host-build.patch` | Harness | Build only the Node half of the selected packages, with no browser bundles |
| `harness-credential-ownership.patch` | Harness | Credential ownership metadata and a read-only check in the authorization service, used by the OpenCode plugin |
| `harness-resume-scan.patch` | Harness | Revision on listed sessions and last-activity time on title reads, for the `/resume` cache |
| `pi-ai-0.86.1-upgrade.patch`, commits [`69a0441`](https://github.com/deepseek-ai/deepseek-harness/commit/69a0441c34019fbb416db35eec0a48470391ddd7) and [`7bab91d`](https://github.com/deepseek-ai/deepseek-harness/commit/7bab91d247e4a7a2e84c68e1883359f5dc718e6a) | Harness | Pi-AI 0.85.1 upgrade, Anthropic replay fix, and the 0.86.1 catalog |
| `tui-harness-compat.patch`, `substituteInPlace` calls in `tui-source.nix` | dsh-tui | Run on the pinned Harness: moved types, renamed session and command APIs, agent-scoped questions, exit on startup failure |
| `tui-reasoning-effort.patch` | dsh-tui | Ctrl+T effort cycling |
| `tui-last-model.patch` | dsh-tui | Remember the last `/model` choice |
| `tui-command-history.patch` | dsh-tui | Respect `recordInput: false`, so rejected `/provider` arguments stay out of prompt history |
| `tui-fork.patch`, `chat-fork.ts`, `session-fork.ts` | dsh-tui | `/fork`, built on `sessions.fork()` and the persistence API |
| `resume.ts` | dsh-tui | `/resume` with the title cache |
| `tui-image-input.patch`, `image-input.ts` | dsh-tui | Image input around the dsh-pi-tui modules |
| `provider-widgets.ts`, `providers/` | dsh-tui | `/provider` and the wizard |

Without `harness-resume-scan.patch`, `/resume` still works but can't cache titles, so each listing reads every log once.

To regenerate `pi-ai-0.86.1-upgrade.patch`, update the `pnpm-lock.yaml` and `pnpm-workspace.yaml` hunks with `pnpm install --lockfile-only` using the pinned `packageManager` version, then update the catalog drift checks in `packages/llm/llm-pi-ai/src/catalog.ts`.

### Checks

```sh
nix flake check --no-build --all-systems
nix flake check --max-jobs 1 --cores 2
```

The package build runs the upstream Harness tests, including the Pi-AI catalog, compatibility and replay tests, and checks every provider catalog through the installed services. It also tests native sign-in and credential storage, the OpenCode plugin (including the profile example from this guide), and starts the installed TUI in a PTY to open `/model` and `/provider`. The flake checks add:

- `compatibility`: a type check of the patched TUI against the packaged Harness, tests for questions, cancellation, resume, providers, reasoning effort, last model, fork and image input, and the wizard's own tests
- `images`: the packaged `read_image` tooling
- `fork`: `/fork` end to end in a PTY
- `launcher`: profile seeding and resets
- `smoke-test`: makes sure the PTY smoke script catches a TUI that exits early
- `formatting`: `nixfmt` on all Nix files

None of them need network access or API keys, so live provider logins and actual image understanding aren't tested. CI runs everything on both architectures.

Provider TypeScript sources and test scripts only exist in the check inputs; the installed package contains compiled JavaScript, type declarations and licenses. The build limits virtual memory while compiling and restores the original limit before the runtime checks.

Installed files don't contain timestamps or temporary store paths. `nix build .#default --rebuild --no-link` confirms that a rebuild is byte-for-byte identical.

## License

The packaging code is [MIT](../LICENSE). Upstream and third-party software in the build keep their own licenses, which are installed with the DeepSeek Harness third-party notice under `share/licenses/deepseek-harness-tui`.
