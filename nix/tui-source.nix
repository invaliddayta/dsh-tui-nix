{
  lib,
  stdenvNoCC,
  nodejs-slim_24,
  pnpm_11,
  fetchPnpmDeps,
  pnpmConfigHook,
  yq-go,
  dsh-tui-src,
  dshTuiPatch,
  limitBuildMemory,
}:
let
  pnpm = pnpm_11.override { nodejs-slim = nodejs-slim_24; };
  tuiManifest = builtins.fromJSON (builtins.readFile (dsh-tui-src + "/package.json"));
  version = tuiManifest.version;
  projectDependencies = ''
    YQ=${lib.getExe yq-go} ${lib.getExe nodejs-slim_24} ${./project-tui-dependencies.mjs}
  '';
  pnpmDeps = fetchPnpmDeps {
    pname = "dsh-tui";
    inherit version;
    src = dsh-tui-src;
    inherit pnpm;
    fetcherVersion = 4;
    hash = "sha256-JcIhS0Yhf0oFnOMEWmWdfJ5y8qcx7fFG4fo6sUwl1Ks=";
    env.NODE_OPTIONS = "--max-old-space-size=2048";
    env.PNPM_MAX_WORKERS = "1";
    nativeBuildInputs = [ yq-go ];
    prePnpmInstall = ''
      ${limitBuildMemory}
      export pnpm_config_child_concurrency=2
      export pnpm_config_network_concurrency=8
      export pnpm_config_auto_install_peers=false
      ${projectDependencies}
    '';
  };
in
stdenvNoCC.mkDerivation {
  pname = "dsh-tui";
  inherit version;
  src = dsh-tui-src;

  inherit pnpmDeps;

  nativeBuildInputs = [
    nodejs-slim_24
    pnpm
    (pnpmConfigHook.override { inherit pnpm; })
    yq-go
  ];

  env.NODE_OPTIONS = "--max-old-space-size=3072";
  env.PNPM_MAX_WORKERS = "1";
  env.pnpm_config_child_concurrency = 2;
  env.pnpm_config_network_concurrency = 8;
  env.pnpm_config_auto_install_peers = "false";

  preConfigure = ''
    ${limitBuildMemory}
    ${projectDependencies}
  '';

  postPatch = ''
    cp ${./provider-widgets.ts} src/provider-widgets.ts
    substituteInPlace tsdown.config.ts \
      --replace-fail "'src/startup.ts']" "'src/startup.ts', 'src/provider-widgets.ts']"
    node --input-type=module <<'EOF'
    import { readFileSync, writeFileSync } from 'node:fs'
    const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
    manifest.exports['./provider-widgets'] = './lib/provider-widgets.js'
    writeFileSync('package.json', JSON.stringify(manifest, null, 2))
    EOF
    patch -p1 < ${./tui-harness-compat.patch}
    patch -p1 < ${./tui-session-compat.patch}
    patch -p1 --fuzz=0 < ${./tui-reasoning-effort.patch}
    patch -p1 --fuzz=0 < ${./tui-command-history.patch}
    substituteInPlace src/startup.ts \
      --replace-fail 'dsh --profile tui' 'dsh-tui'
    substituteInPlace src/chat/skill-invocation.ts \
      --replace-fail \
        "import { assertNever } from '@deepseek-ai/dsh-llm'" \
        "import { assertNever } from '@deepseek-ai/dsh-util-values'"
    substituteInPlace src/chat/tokens.ts src/chat/helpers.ts \
      --replace-fail 'session.events' 'session.snapshotEvents()'
    substituteInPlace src/index.ts \
      --replace-fail 'agent.session.events' 'agent.session.snapshotEvents()'
    substituteInPlace src/index.ts \
      --replace-fail \
        'ctx.commands.execute(agent, text, controller.signal)' \
        'ctx.commands.execute(agent, text, [], controller.signal)'
  '';

  buildPhase = ''
    runHook preBuild
    pnpm exec tsdown
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    pnpm --filter @dsh-tui/dsh-tui --prod --offline --ignore-scripts \
      --config.inject-workspace-packages=true \
      --config.auto-install-peers=false \
      --config.node-linker=hoisted \
      deploy "$out/package"
    # Installation state is not runtime data and contains non-reproducible paths/times.
    rm -f "$out/package/node_modules/"{.modules.yaml,.pnpm-workspace-state-v1.json}
    rm -rf "$out/package/lib"
    cp -a lib "$out/package/lib"
    cp ${dshTuiPatch} "$out/package/cordis.patch.yml"
    runHook postInstall
  '';

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck

    test -f "$out/package/lib/index.js"
    test -f "$out/package/lib/startup.js"
    test ! -e "$out/package/node_modules/.modules.yaml"
    test ! -e "$out/package/node_modules/.pnpm-workspace-state-v1.json"
    for harnessPeer in "$out/package/node_modules/@deepseek-ai/"*; do
      if [ -e "$harnessPeer" ]; then
        echo "source-built TUI contains auto-installed Harness peers" >&2
        exit 1
      fi
    done
    grep -F 'from "@deepseek-ai/dsh-util-values"' "$out/package/lib/index.js" >/dev/null
    grep -F 'session.snapshotEvents()' "$out/package/lib/index.js" >/dev/null
    grep -F 'foldSessionTitle(snapshot.events)' "$out/package/lib/index.js" >/dev/null
    if grep -F 'live.events' "$out/package/lib/index.js" >/dev/null; then
      echo "source-built TUI still reads the removed Session.events property" >&2
      exit 1
    fi
    grep -F 'ctx.commands.execute(agent, text, [], controller.signal)' "$out/package/lib/index.js" >/dev/null
    grep -F 'dsh-tui' "$out/package/lib/startup.js" >/dev/null

    runHook postInstallCheck
  '';

  passthru = { inherit pnpmDeps; };

  meta = {
    description = "Terminal UI for DeepSeek Harness";
    homepage = "https://github.com/dsh-tui/dsh-tui";
    license = lib.licenses.mit;
    platforms = [
      "aarch64-linux"
      "x86_64-linux"
    ];
  };
}
