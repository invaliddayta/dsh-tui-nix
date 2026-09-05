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
    pnpm exec tsc -p tsconfig.json --noEmit
    cp ${../tests/compatibility.spec.ts} tests/nix-compatibility.spec.ts
    pnpm exec vitest run tests/nix-compatibility.spec.ts --maxWorkers=1 --minWorkers=1
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    touch "$out"
    runHook postInstall
  '';
  doInstallCheck = false;
})
