# OpenCode Credentials for Harness

`dsh-credentials-opencode` is an optional credential-service plugin, independent
of any TUI. It extends Harness's local credential provider with explicit,
read-only bindings into OpenCode's `auth.json`. It has no Pi SDK, UI, network,
or OAuth-refresh dependency.

This distribution builds it against its pinned Harness peers, including
`nix/harness-credential-ownership.patch`. That patch adds optional ownership and
diagnostic metadata and a shared authorization preflight. The package is not
published to npm; the pinned stock Harness revision does not include that patch.

## Prerequisites

Your credential-owning harness must already be configured and signed in. This
plugin supports **OpenCode only**, not arbitrary harnesses: install/configure
OpenCode and sign in to the desired providers before enabling it. Its credential
store must be accessible to the user running Harness on the target machine.
The plugin does not install OpenCode, bootstrap credentials, import provider
settings, or synchronize another machine's credential store.

OpenCode need not be running to read an existing store. The plugin does not invoke
its CLI, but sign-in and OAuth refresh still require OpenCode; neither is performed
automatically by this plugin. Without that existing setup, use Harness's native
credential provider instead.

The full DSH TUI distribution bundles the required Harness runtime and this
plugin. Using the plugin separately requires an existing compatible Harness
installation with the credential-ownership patch described above; the plugin
alone is not a runnable harness.

## Configuration

Disable the existing credential service and insert this plugin. The loader's
`name` field is a match guard, not a way to replace a plugin:

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

`records` keys are full Harness `<scope>/<id>` addresses, validated by Harness.
There is no hard-coded `llm-pi-ai` namespace. API bindings produce Harness
`api-key` records; OAuth bindings produce grant payloads in OpenCode/Pi format.
The consuming adapter must understand that grant format. This is not a universal
OAuth protocol translator.

`refs` keys are validated credential-reference names, mapped to OpenCode API-key
provider IDs. An explicitly inherited environment value still wins for a bound
reference. Unbound references and records retain the native provider's behavior.

`authPath` defaults to `$XDG_DATA_HOME/opencode/auth.json`, or
`~/.local/share/opencode/auth.json`. Native `path`, `dshHome`, `watch`, and
`debounceMs` options configure only the local Harness store. External credentials
are re-read per operation; they are not cached or copied into that store.

Enable model routes separately in Harness settings. Match endpoint, protocol and
credential type explicitly: OpenCode provider names need not match Pi provider
names or endpoints. No model catalog, request options, plugins, or model aliases
are imported automatically.

## Ownership and Diagnostics

Bound addresses always report `writable: false` and `owner: OpenCode`, including
when the credential is missing. Valid OAuth descriptions include `expiresAt`
in Unix milliseconds. Safe diagnostic codes are:

- `MISSING_CREDENTIAL`: no entry is stored in OpenCode.
- `INVALID_CREDENTIAL`: the entry is malformed or contains a dummy/empty key.
- `AUTH_TYPE_CHANGED`: the configured API/OAuth type no longer matches the entry.
- `REFRESH_REQUIRED`: OAuth expires within five minutes or has already expired.
- `STORE_UNAVAILABLE`: the store cannot be safely read or parsed.

Enumeration skips invalid bindings and preserves healthy native/external entries;
describe the relevant bound address to obtain its diagnostic. If the whole
external store is unreadable, native entries remain enumerable. Direct credential
reads still fail closed, never revealing a stale native credential at a bound
address. Error messages do not include parser output or secret values.

The store must be a regular file owned by the current user, with no group/other
permission bits. These checks target the distribution's supported Linux systems.

## OAuth Lifecycle

OpenCode remains the only credential writer and refresh owner. This plugin refuses
mutations before invoking their callbacks: Pi may perform a network refresh and
rotate a token inside such a callback. Refusing only the final file write would
be too late. Signing out through DSH cannot remove OpenCode's credentials.

Use OpenCode to sign in or refresh and then retry in Harness. Expiry diagnostics
do not promise seamless refresh, account entitlement, or provider acceptance of
another client's requests. Known compatible unexpired grant payloads include
OpenAI Codex, xAI, and Anthropic; provider policies still apply.

## Upstream Boundary

This package is the optional OpenCode-specific integration. Ownership metadata
and authorization preflight belong in Harness core; presenting those facts
belongs in each UI. The TUI consumes the generic credential metadata without
importing this package. Provider bindings and machine-specific endpoints remain
user configuration.
