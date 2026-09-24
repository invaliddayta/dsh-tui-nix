# Contributing

This is a personal build that I keep small. Bug reports and fixes are welcome. Please open an issue before working on a new feature, since many things are better done in your own profile patch than here.

Bugs in DeepSeek Harness itself go to the [Harness project](https://github.com/deepseek-ai/deepseek-harness/discussions), and bugs in the TUI to [dsh-tui](https://github.com/dsh-tui/dsh-tui/issues).

Source pins and local patches are described in the [maintenance section](docs/guide.md#maintenance) of the guide. Patches have to apply with `--fuzz=0`. If you add one, add it to the [patch table](docs/guide.md#carried-patches) with the condition for removing it.

Before sending a change:

```sh
nix fmt
nix flake check --no-build --all-systems
nix flake check --max-jobs 1 --cores 2
```

Changes to pins, patches or runtime dependencies should be checked on both x86_64 and aarch64. CI does this for pull requests.
