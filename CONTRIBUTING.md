# Contributing

Issues and pull requests are welcome for anything in this repository: the Nix package, runtime projection, launcher, profile, and docs.

Report DeepSeek Harness bugs to the [upstream project](https://github.com/deepseek-ai/deepseek-harness/discussions) and dsh-tui bugs to the [TUI project](https://github.com/dsh-tui/dsh-tui/issues).

Before submitting a packaging change, run:

```sh
nix flake check --no-build --all-systems
nix flake check --max-jobs 1 --cores 2
```

If your change touches a source pin, compatibility patch, or the runtime dependency selection, run the checks natively on both supported architectures.
