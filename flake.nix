{
  description = "Slim, TUI-first DeepSeek Harness distribution";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/3ed67ec0a4d3c7ab4ae1f04f8ee8df07bfa506a2";

    deepseek-harness-src = {
      url = "github:deepseek-ai/deepseek-harness/76fda729799fe9b3848dbe2c211d4b231032b81e";
      flake = false;
    };

    dsh-tui-src = {
      url = "github:dsh-tui/dsh-tui/8bdc850732464e2c10278f47b4f2b82da38d801e";
      flake = false;
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      deepseek-harness-src,
      dsh-tui-src,
      ...
    }:
    let
      systems = [
        "aarch64-linux"
        "x86_64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          package = pkgs.callPackage ./nix/package.nix {
            harness-src = deepseek-harness-src;
            inherit dsh-tui-src;
          };
        in
        {
          default = package;
          deepseek-harness-tui = package;
          dsh-tui = package;
          credentials-opencode = package.passthru.credentialsOpencode;
          harness-pnpm-deps = package.passthru.pnpmDeps;
          tui = package.passthru.tui;
          tui-pnpm-deps = package.passthru.tui.passthru.pnpmDeps;
        }
      );

      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = "${self.packages.${system}.default}/bin/dsh-tui";
          meta.description = "Run the DeepSeek Harness terminal UI";
        };
      });

      checks = forAllSystems (system: {
        package = self.packages.${system}.default;
        tui = self.packages.${system}.tui;
        compatibility = import ./nix/tui-checks.nix {
          package = self.packages.${system}.default;
        };
        launcher =
          nixpkgs.legacyPackages.${system}.runCommand "tui-launcher-check"
            {
              nativeBuildInputs = [ nixpkgs.legacyPackages.${system}.nodejs-slim_24 ];
            }
            ''
              DSH_LAUNCHER_SOURCE=${./nix} node --test ${./tests/launcher.test.mjs}
              touch "$out"
            '';
        smoke-test =
          nixpkgs.legacyPackages.${system}.runCommand "tui-smoke-test-check"
            {
              nativeBuildInputs = [ nixpkgs.legacyPackages.${system}.expect ];
            }
            ''
              bash ${./tests/smoke.sh} ${./nix/tui-smoke.exp}
              touch "$out"
            '';
      });

      formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixfmt-tree);
    };
}
