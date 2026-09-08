{ package }:

package.tui.overrideAttrs (_: {
  pname = "dsh-tui-compatibility-check";
  # Native test tooling reserves large virtual address ranges on x86_64.
  # Keep NODE_OPTIONS and worker limits, but do not inherit the build's ulimit -v.
  preConfigure = ''
    node ${./project-tui-dependencies.mjs}
  '';
  buildPhase = ''
    runHook preBuild
    # Resolve the patched source against the shipped peers, never npm peers.
    ln -s ${package}/libexec/dsh/node_modules/@deepseek-ai node_modules/@deepseek-ai
    ln -s ${package}/libexec/dsh/node_modules/@dsh-tui node_modules/@dsh-tui
    pnpm exec tsc -p tsconfig.json --noEmit
    cp -r ${package.providers}/checks/src src/providers
    chmod -R u+w src/providers
    node --input-type=module <<'EOF'
    import { readFileSync, writeFileSync } from 'node:fs'
    const config = { extends: './tsconfig.json', include: ['src/providers'], compilerOptions: { exactOptionalPropertyTypes: false } }
    config.compilerOptions.paths = {
      '@dsh-tui/dsh-tui': ['./src/index.ts'],
      '@dsh-tui/dsh-tui/provider-widgets': ['./src/provider-widgets.ts'],
    }
    writeFileSync('tsconfig.providers.json', JSON.stringify(config))
    EOF
    pnpm exec tsc -p tsconfig.providers.json --noEmit
    cp -r ${package.tui}/package/lib .
    cp ${../tests/compatibility.spec.ts} tests/nix-compatibility.spec.ts
    cp ${../tests/providers.spec.ts} tests/nix-providers.spec.ts
    cp ${../tests/reasoning.spec.ts} tests/nix-reasoning.spec.ts
    pnpm exec vitest run tests/nix-compatibility.spec.ts tests/nix-providers.spec.ts tests/nix-reasoning.spec.ts --maxWorkers=1 --minWorkers=1
    mkdir -p wizard-check/scripts wizard-check/lib/types/dsh-adapter
    cp ${package.providers}/checks/scripts/verify-provider-wizard.mjs wizard-check/scripts/
    cp -r ${package.providers}/package/lib/upstream/. wizard-check/lib/types/
    cp wizard-check/lib/types/host.js wizard-check/lib/types/dsh-adapter/channel.js
    DSH_TUI_LANG=en node wizard-check/scripts/verify-provider-wizard.mjs
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    touch "$out"
    runHook postInstall
  '';
  doInstallCheck = false;
})
