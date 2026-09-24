# dsh-credentials-opencode

A credential-service plugin for DeepSeek Harness that reads API keys and OAuth logins from OpenCode's `auth.json`. It extends Harness's local credential provider with explicit, read-only mappings. It doesn't depend on any UI, the Pi SDK or the network, and it never refreshes OAuth tokens itself.

It needs the ownership metadata and authorization check from `nix/harness-credential-ownership.patch`, which stock Harness doesn't have yet. For that reason it isn't published to npm; it's built and bundled with this repository's package, which includes the patch.

## Requirements

OpenCode must be installed and signed in to the providers you want, on the same machine and user account. The plugin doesn't install OpenCode, create credentials, import provider settings or sync between machines. OpenCode doesn't have to be running, but signing in and refreshing logins happen in OpenCode. If you don't use OpenCode, use Harness's native credential provider.

## Configuration

Disable the stock credential service and insert this plugin under a new ID. In loader patches `name` only guards the match, so renaming the existing entry won't replace it.

```yaml
- id: credentials
  disabled: true
- insert:
    - id: opencode-credentials
      name: dsh-credentials-opencode
      config:
        records:
          llm-pi-ai/kimi-coding: { provider: kimi-for-coding, type: api }
          llm-pi-ai/openai-codex: { provider: openai, type: oauth }
        refs:
          DEEPSEEK_API_KEY: deepseek
```

`records` keys are full Harness `<scope>/<id>` addresses, validated by Harness; `llm-pi-ai` is not hard-coded. `api` mappings produce Harness `api-key` records. `oauth` mappings produce grants in OpenCode's (and Pi's) format, so the adapter using them has to understand that format.

`refs` maps credential reference names to OpenCode API-key providers. A value set in the environment still takes precedence. Unmapped references and records behave as they do with the native provider.

`authPath` defaults to `$XDG_DATA_HOME/opencode/auth.json`, or `~/.local/share/opencode/auth.json`. The native `path`, `dshHome`, `watch` and `debounceMs` options only affect Harness's own store. OpenCode's file is read on every access and never cached or copied.

Model routes are enabled separately in Harness settings. OpenCode and Pi provider names don't always refer to the same endpoint, so check endpoint, protocol and credential type before mapping. Model lists, request options, plugins and aliases aren't imported.

## Ownership and diagnostics

Mapped addresses always report `writable: false` and `owner: OpenCode`, even when the credential is missing. Valid OAuth entries include `expiresAt` in Unix milliseconds. Diagnostic codes:

- `MISSING_CREDENTIAL`: OpenCode has no entry for the provider.
- `INVALID_CREDENTIAL`: the entry is malformed or has an empty or dummy key.
- `AUTH_TYPE_CHANGED`: the entry's type no longer matches the configured `api` or `oauth`.
- `REFRESH_REQUIRED`: the OAuth login has expired or expires within five minutes.
- `STORE_UNAVAILABLE`: the file can't be read or parsed safely.

Listing credentials skips broken mappings and keeps the rest, including native entries when OpenCode's whole file is unreadable. Describe a mapped address to get its diagnostic. Reading a mapped credential fails when it's unusable, and never falls back to an old native credential at that address. Error messages don't include parser output or secrets.

The file must be a regular file owned by the current user with no group or other permissions. These checks assume Linux.

## OAuth

OpenCode is the only writer and the only one that refreshes. The plugin refuses refresh, replace and sign-out before running their callbacks, because Pi may already rotate a token over the network inside such a callback. Signing out in Harness doesn't remove anything from OpenCode.

When a login expires, sign in again in OpenCode and retry. Unexpired OpenAI Codex, xAI and Anthropic grants are known to work, but each provider decides whether it accepts requests made with another client's login.

## Design

Only OpenCode-specific code lives in this package. Ownership metadata and the authorization check belong in Harness core, and each UI decides how to display them. The TUI reads the generic metadata and doesn't import this package. Provider mappings and machine-specific endpoints are user configuration.
