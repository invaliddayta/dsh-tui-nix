<p align="center">
  <img src="docs/banner.svg" alt="DeepSeek Harness TUI" width="1200">
</p>

# dsh-tui-nix

My build of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) with the [dsh-tui](https://github.com/dsh-tui/dsh-tui) terminal frontend, packaged with Nix. It's what I use as a coding agent every day. It follows my preferences and only adds features I've needed, so if you want stock dsh-tui, install that instead.

```sh
nix run github:invaliddayta/dsh-tui-nix
```

Linux only (x86-64 and ARM64), with Nix flakes enabled. The first run builds everything from source and takes a while. Sign in with `/provider`, or set `DEEPSEEK_API_KEY` before starting.

## Defaults

- Terminal UI only. The Harness web app, browser gateway and telemetry exporter aren't built, and session telemetry is off.
- Starts on `deepseek-official/deepseek-v4-pro` with thinking at maximum effort. Once you pick a model in `/model`, that becomes the default for new sessions.
- The system prompt asks for short answers and for work to be checked by running code or tests.
- Reasoning is shown, tool output is cut to six lines, and the agent sees tmux context.

## Changes from dsh-tui

- `/provider`: sign in with an API key or browser login, or add custom OpenAI/Anthropic-compatible endpoints. Keys are typed into a masked dialog, never into the chat.
- Ctrl+T cycles the reasoning effort of the current model.
- Images: paste with Ctrl+V, drop a file on the terminal, or use `/image <path>`. Needs a model that accepts images, such as `zai/glm-5.3-flash`.
- `/resume` caches session titles, so the list opens quickly on large session stores.
- `/fork` copies the conversation so far into a new session. Files in the workspace are not copied.
- An optional plugin reads keys and logins from an existing OpenCode install.

Other keys are dsh-tui's own: Esc cancels a turn, Ctrl+O changes how much of each tool call is shown, Ctrl+R hides reasoning, and `/help` lists the rest.

There are no plans for a web or desktop UI, themes, inline image rendering, or macOS support. My MCP servers and per-model subagents are set up in my own profile patch, which isn't part of this repository.

## Configuration

| What | Where |
| --- | --- |
| Providers and endpoints | `/provider`, or `llm-pi-ai` in `~/.dsh/settings.yaml` ([guide](docs/guide.md#manual-configuration)) |
| Default model, system prompt, plugins | `~/.dsh/profiles/deepseek-harness-tui/cordis.patch.yml` ([guide](docs/guide.md#profile)) |
| OpenCode credentials | [guide](docs/guide.md#opencode-credentials) |

`$DSH_HOME` replaces `~/.dsh` when set. [docs/guide.md](docs/guide.md) covers everything in more detail, including how the package is built and maintained.

> [!IMPORTANT]
> The agent runs shell commands and edits files. Read the upstream [safety notice](https://github.com/deepseek-ai/deepseek-harness/blob/76fda729799fe9b3848dbe2c211d4b231032b81e/SAFETY.md). Prompts are sent to whichever provider you configure, and the web search tool always uses DeepSeek, so it needs `DEEPSEEK_API_KEY` even when you chat with another model.

## Credits and license

Built on DeepSeek Harness and dsh-tui. The provider wizard comes from [ccch1mneyyy/dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI) and the image input code from [XMoon/dsh-pi-tui](https://github.com/XMoon/dsh-pi-tui). This is not an official DeepSeek project.

The packaging in this repository is [MIT](LICENSE). Bundled software keeps its own licenses, which are installed under `share/licenses/deepseek-harness-tui`.
