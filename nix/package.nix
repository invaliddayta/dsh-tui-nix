{
  lib,
  stdenv,
  stdenvNoCC,
  nodejs-slim_24,
  pnpm_11,
  fetchPnpmDeps,
  fetchFromGitHub,
  fetchpatch,
  typescript,
  pnpmConfigHook,
  makeWrapper,
  autoPatchelfHook,
  pkgsStatic,
  bashNonInteractive,
  bubblewrap,
  coreutils,
  expect,
  gitMinimal,
  ncurses,
  pkg-config,
  python3,
  yq-go,
  harness-src,
  dsh-tui-src,
}:
let
  pnpm = pnpm_11.override { nodejs-slim = nodejs-slim_24; };
  cliManifest = builtins.fromJSON (builtins.readFile (harness-src + "/apps/cli/package.json"));
  version = cliManifest.version;
  profileName = "deepseek-harness-tui";
  profileTemplateVersion = "${version}-${
    builtins.substring 0 12 (
      builtins.hashString "sha256" (
        builtins.concatStringsSep "\n" (
          map builtins.readFile [
            ./tui-profile/package.json
            ./tui-profile/cordis.yml
            ./tui-profile/pnpm-workspace.yaml
          ]
        )
      )
    )
  }";
  limitBuildMemory = ''
    dshOriginalVirtualMemoryLimit=$(ulimit -S -v)
    if [ "$dshOriginalVirtualMemoryLimit" = unlimited ] || [ "$dshOriginalVirtualMemoryLimit" -gt 10485760 ]; then
      ulimit -S -v 10485760
    fi
  '';
  # Backport the upstream Pi-AI update without unrelated Harness/session changes.
  # Remove these when the Harness pin includes both commits.
  piAiPatches =
    map
      (
        { rev, hash }:
        fetchpatch {
          url = "https://github.com/deepseek-ai/deepseek-harness/commit/${rev}.patch";
          inherit hash;
          includes = [
            "packages/llm/llm-pi-ai/*"
            "pnpm-lock.yaml"
            "pnpm-workspace.yaml"
          ];
        }
      )
      [
        {
          rev = "69a0441c34019fbb416db35eec0a48470391ddd7";
          hash = "sha256-AY38vMsX046BCjmz32nJfCHyOH0yX1/jU19oRIRQ1HU=";
        }
        {
          rev = "7bab91d247e4a7a2e84c68e1883359f5dc718e6a";
          hash = "sha256-ACJJtmU7ecHW7y+jUi0bhjlpovjZ0mkcD6INTF/WxHQ=";
        }
      ];
  projectRuntime = ''
    ${lib.concatMapStringsSep "\n" (patch: "patch -p1 --fuzz=0 < ${patch}") piAiPatches}
    # Selected workspaces need their Node half, never their browser bundle.
    patch -p1 --fuzz=0 < ${./harness-host-build.patch}
    mkdir -p nix
    cp ${./project-tui-runtime.mjs} nix/project-tui-runtime.mjs
    cp ${./build-runtime.mjs} nix/build-runtime.mjs
    YQ=${lib.getExe yq-go} DSH_TUI_MANIFEST=${dsh-tui-src}/package.json \
      ${lib.getExe nodejs-slim_24} nix/project-tui-runtime.mjs
  '';

  sourcePaths = [
    "package.json"
    "pnpm-lock.yaml"
    "pnpm-workspace.yaml"
    "tsconfig.json"
    "tsconfig.base.json"
    "tsconfig.base.client.json"
    "tsconfig.host.json"
    "tsconfig.client.json"
    "tsdown.config.ts"
    "patches"
    "vendor"
    "packages"
    "apps/cli"
    "native"
    "scripts/client-build-environment.ts"
  ];
  dshSrc = lib.sources.cleanSourceWith {
    name = "deepseek-harness-tui-source";
    src = harness-src;
    filter =
      path: _type:
      let
        relativePath = lib.removePrefix "${harness-src}/" (toString path);
      in
      relativePath == ""
      || relativePath == "."
      || lib.any (
        sourcePath:
        relativePath == sourcePath
        || lib.hasPrefix "${sourcePath}/" relativePath
        || lib.hasPrefix "${relativePath}/" sourcePath
      ) sourcePaths;
  };

  tui = import ./tui-source.nix {
    inherit
      lib
      stdenvNoCC
      nodejs-slim_24
      pnpm_11
      fetchPnpmDeps
      pnpmConfigHook
      yq-go
      dsh-tui-src
      limitBuildMemory
      ;
    dshTuiPatch = ./dsh-tui.cordis.patch.yml;
  };

  providers = import ./providers.nix {
    inherit
      lib
      stdenvNoCC
      nodejs-slim_24
      typescript
      fetchFromGitHub
      ;
  };

  pnpmDeps = fetchPnpmDeps {
    pname = "deepseek-harness-tui-runtime";
    inherit version pnpm;
    src = dshSrc;
    pnpmWorkspaces = [
      "@deepseek-ai/dsh-root"
      "@deepseek-ai/dsh..."
      "@deepseek-ai/dsh-typert-generator..."
    ];
    fetcherVersion = 4;
    hash = "sha256-S/3+HQZslFySRdiGAFMO2/NBxxHMNGlrMh1f2sYyh+0=";
    env.NODE_OPTIONS = "--max-old-space-size=2048";
    # pnpm workers each reserve a V8 code range under our address-space limit.
    env.PNPM_MAX_WORKERS = "1";
    nativeBuildInputs = [ yq-go ];
    prePnpmInstall = ''
      ${limitBuildMemory}
      export pnpm_config_child_concurrency=2
      export pnpm_config_network_concurrency=8
      ${projectRuntime}
    '';
  };
in
stdenv.mkDerivation (finalAttrs: {
  pname = "deepseek-harness-tui";
  inherit version;
  src = dshSrc;

  inherit pnpmDeps;
  pnpmWorkspaces = [
    "@deepseek-ai/dsh-root"
    "@deepseek-ai/dsh..."
    "@deepseek-ai/dsh-typert-generator..."
  ];

  nativeBuildInputs = [
    nodejs-slim_24
    pnpm
    (pnpmConfigHook.override { inherit pnpm; })
    makeWrapper
    autoPatchelfHook
    python3
    pkg-config
    yq-go
  ];

  nativeInstallCheckInputs = [ expect ];

  buildInputs = [
    stdenv.cc.cc.lib
    ncurses
  ];

  autoPatchelfIgnoreMissingDeps = [ "libc.musl-*.so.*" ];

  env.NODE_OPTIONS = "--max-old-space-size=4096";
  env.PNPM_MAX_WORKERS = "1";
  env.pnpm_config_child_concurrency = 2;
  env.pnpm_config_network_concurrency = 8;

  preConfigure = ''
    ${limitBuildMemory}
    ${projectRuntime}
  '';

  buildPhase = ''
    runHook preBuild

    ${lib.getExe nodejs-slim_24} nix/build-runtime.mjs

    mkdir -p native/landlock-run/packages/linux-${stdenv.hostPlatform.node.arch}/bin
    ${lib.getExe pkgsStatic.stdenv.cc} \
      -std=c11 -Os -Wall -Wextra -Werror -static -s \
      -o native/landlock-run/packages/linux-${stdenv.hostPlatform.node.arch}/bin/landlock-run \
      native/landlock-run/packages/entry/src/main.c

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    pnpm --filter @deepseek-ai/dsh --prod --offline --ignore-scripts \
      --config.inject-workspace-packages=true \
      --config.node-linker=hoisted \
      --config.link-workspace-packages=true \
      deploy "$out/libexec/dsh"

    # pnpm deployment state embeds timestamps and temporary build-store paths.
    rm -f "$out/libexec/dsh/node_modules/"{.modules.yaml,.pnpm-workspace-state-v1.json}

    mkdir -p "$out/libexec/dsh/node_modules/@dsh-tui"
    cp -a ${tui}/package "$out/libexec/dsh/node_modules/@dsh-tui/dsh-tui"
    cp -a ${providers}/package "$out/libexec/dsh/node_modules/@dsh-tui/providers"

    mkdir -p "$out/share/dsh/profiles/${profileName}"
    cp -r ${./tui-profile}/. "$out/share/dsh/profiles/${profileName}/"

    licenseDir="$out/share/licenses/deepseek-harness-tui"
    mkdir -p "$licenseDir"
    cp ${../LICENSE} "$licenseDir/PACKAGING-LICENSE"
    cp ${harness-src}/LICENSE "$licenseDir/DEEPSEEK-HARNESS-LICENSE"
    cp ${harness-src}/THIRD_PARTY_NOTICES.md "$licenseDir/THIRD_PARTY_NOTICES.md"
    cp ${dsh-tui-src}/LICENSE "$licenseDir/DSH-TUI-LICENSE"
    cp ${providers}/package/UPSTREAM-LICENSE "$licenseDir/PROVIDER-WIZARD-LICENSE"

    mkdir -p "$out/libexec/dsh/bin"
    makeWrapper ${lib.getExe nodejs-slim_24} "$out/libexec/dsh/bin/dsh" \
      --add-flags --expose-internals \
      --add-flags "$out/libexec/dsh/lib/bin.js" \
      --prefix PATH : ${
        lib.makeBinPath [
          bashNonInteractive
          bubblewrap
          coreutils
          gitMinimal
          nodejs-slim_24
        ]
      } \
      --prefix LD_LIBRARY_PATH : ${lib.makeLibraryPath [ stdenv.cc.cc.lib ]} \
      --set-default DSH_TELEMETRY_DISABLED 1

    mkdir -p "$out/bin"
    substitute ${./dsh-tui.sh} "$out/bin/dsh-tui" \
      --replace-fail @out@ "$out" \
      --replace-fail @profileVersion@ "${profileTemplateVersion}"
    chmod +x "$out/bin/dsh-tui"
    wrapProgram "$out/bin/dsh-tui" \
      --prefix PATH : ${lib.makeBinPath [ coreutils ]}

    runHook postInstall
  '';

  preFixup = ''
    sharpNativeBackup=$(mktemp -d)
    sharpPackage="$out/libexec/dsh/node_modules/@img/sharp-linux-${stdenv.hostPlatform.node.arch}"
    sharpVips="$out/libexec/dsh/node_modules/@img/sharp-libvips-linux-${stdenv.hostPlatform.node.arch}"
    if [ -d "$sharpPackage" ]; then mv "$sharpPackage" "$sharpNativeBackup/"; fi
    if [ -d "$sharpVips" ]; then mv "$sharpVips" "$sharpNativeBackup/"; fi

    restoreSharpNative() {
      if [ -d "$sharpNativeBackup/sharp-linux-${stdenv.hostPlatform.node.arch}" ]; then
        mv "$sharpNativeBackup/sharp-linux-${stdenv.hostPlatform.node.arch}" "$out/libexec/dsh/node_modules/@img/"
      fi
      if [ -d "$sharpNativeBackup/sharp-libvips-linux-${stdenv.hostPlatform.node.arch}" ]; then
        mv "$sharpNativeBackup/sharp-libvips-linux-${stdenv.hostPlatform.node.arch}" "$out/libexec/dsh/node_modules/@img/"
      fi
    }
    postFixupHooks+=(restoreSharpNative)
  '';

  doInstallCheck = true;
  installCheckPhase = ''
    # V8 test workers reserve more address space than the build cap permits.
    # Restore the caller's limit, keeping the heap and worker limits in place.
    ulimit -S -v "$dshOriginalVirtualMemoryLimit"
    runHook preInstallCheck

    node --input-type=module <<'EOF'
    import assert from 'node:assert/strict'
    import { existsSync, readFileSync } from 'node:fs'
    import { join } from 'node:path'
    const packages = JSON.parse(readFileSync('nix/tui-runtime-workspaces.json', 'utf8'))
    for (const { name, path } of packages) {
      if (path.startsWith('native/')) continue
      const root = name === '@deepseek-ai/dsh' ? process.env.out + '/libexec/dsh'
        : join(process.env.out, 'libexec/dsh/node_modules', name)
      const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
      if (manifest.main) assert(existsSync(join(root, manifest.main)), name + ' is missing its Node entry')
      if (manifest.dsh?.client) assert(!existsSync(join(root, 'lib/client.js')), name + ' contains a browser bundle')
    }
    EOF

    # Upstream tests resolve this peer through tsconfig paths; use its built workspace here.
    mkdir -p node_modules/@deepseek-ai
    ln -s "$PWD/packages/settings/settings-file" node_modules/@deepseek-ai/dsh-settings-file
    pnpm exec vitest run packages/llm/llm-pi-ai/tests/{catalog,compat-upgrade,convert}.spec.ts \
      --maxWorkers=1
    test "$("$out/libexec/dsh/bin/dsh" --version)" = "${finalAttrs.version}"
    test ! -e "$out/libexec/dsh/node_modules/@deepseek-ai/dsh-web-app"
    test ! -e "$out/libexec/dsh/node_modules/@deepseek-ai/dsh-web-frontend"
    test ! -e "$out/libexec/dsh/node_modules/@deepseek-ai/dsh-host-webserver"
    test ! -e "$out/libexec/dsh/node_modules/@deepseek-ai/dsh-terminal-bash"
    test ! -e "$out/libexec/dsh/node_modules/@deepseek-ai/dsh-api-gateway"
    test ! -e "$out/libexec/dsh/node_modules/@deepseek-ai/dsh-command-feedback"
    test -e "$out/libexec/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai"
    test ! -e "$out/libexec/dsh/node_modules/@deepseek-ai/dsh-session-telemetry-otel"
    test -e "$out/libexec/dsh/node_modules/@earendil-works/pi-ai"
    test ! -e "$out/libexec/dsh/node_modules/react"
    test ! -e "$out/libexec/dsh/node_modules/.modules.yaml"
    test ! -e "$out/libexec/dsh/node_modules/.pnpm-workspace-state-v1.json"
    test ! -e "$out/libexec/dsh/node_modules/react-reconciler"
    test ! -e "$out/libexec/dsh/node_modules/@dsh-tui/providers/src"
    test ! -e "$out/libexec/dsh/node_modules/@deepseek-harness-tui/dsh-auth"
    node ${../tests/provider-authorization.mjs} "$out/libexec/dsh"
    # Provider SDKs bring the OTel API and HTTP libraries, but no exporter.
    for telemetryPackage in "$out/libexec/dsh/node_modules/@opentelemetry/"{sdk-*,exporter-*}; do
      test ! -e "$telemetryPackage"
    done
    grep -F 'mode: !!js' "$out/libexec/dsh/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml" >/dev/null
    grep -F 'policy: !!js' "$out/libexec/dsh/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml" >/dev/null
    for clientPackage in "$out/libexec/dsh/node_modules/@deepseek-ai/dsh-client-"*; do
      if [ -e "$clientPackage" ]; then
        echo "TUI runtime contains browser-only dsh-client packages" >&2
        exit 1
      fi
    done

    launcher="$out/libexec/dsh/node_modules/@deepseek-ai/node-addon-landlock-run-linux-${stdenv.hostPlatform.node.arch}/bin/landlock-run"
    test -x "$launcher"
    if "$launcher" --probe >/dev/null 2>&1; then
      mkdir -p "$TMPDIR/landlock-allowed"
      if "$launcher" --ro / --rw "$TMPDIR/landlock-allowed" -- \
        touch "$TMPDIR/landlock-denied" 2>/dev/null; then
        echo "landlock-run allowed a write outside its writable grant" >&2
        exit 1
      fi
      test ! -e "$TMPDIR/landlock-denied"
    fi

    export DSH_HOME="$TMPDIR/dsh-home"
    profileDir="$DSH_HOME/profiles/${profileName}"
    "$out/bin/dsh-tui" --help > "$TMPDIR/dsh-tui-help"
    grep -F 'Usage: dsh-tui [options]' "$TMPDIR/dsh-tui-help" >/dev/null
    test "$(<"$profileDir/.managed-by-deepseek-harness-tui")" = deepseek-harness-tui-profile-v1
    test "$(<"$profileDir/.nix-package-version")" = "${profileTemplateVersion}"
    printf '%s\n' '[] # user patch' > "$profileDir/cordis.patch.yml"
    printf '%s\n' stale > "$profileDir/.nix-package-version"
    "$out/bin/dsh-tui" --help >/dev/null 2>"$TMPDIR/dsh-tui-stale"
    grep -F "profile template is stale" "$TMPDIR/dsh-tui-stale" >/dev/null
    test "$(<"$profileDir/.nix-package-version")" = stale
    grep -F '[] # user patch' "$profileDir/cordis.patch.yml" >/dev/null
    DSH_TUI_RESET_PROFILE=1 "$out/bin/dsh-tui" --help >/dev/null
    test "$(<"$profileDir/.nix-package-version")" = "${profileTemplateVersion}"
    grep -F '[] # user patch' "$profileDir/cordis.patch.yml" >/dev/null

    unownedHome="$TMPDIR/unowned-home"
    unownedProfile="$unownedHome/profiles/${profileName}"
    mkdir -p "$unownedProfile"
    printf '%s\n' '{"name":"user-profile"}' > "$unownedProfile/package.json"
    if DSH_HOME="$unownedHome" DSH_TUI_RESET_PROFILE=1 "$out/bin/dsh-tui" --help \
      >"$TMPDIR/unowned.stdout" 2>"$TMPDIR/unowned.stderr"; then
      echo "dsh-tui replaced an unowned profile" >&2
      exit 1
    fi
    grep -F "refusing to replace unowned profile" "$TMPDIR/unowned.stderr" >/dev/null
    grep -F 'user-profile' "$unownedProfile/package.json" >/dev/null

    "$out/libexec/dsh/bin/dsh" --profile ${profileName} --dump-config > "$TMPDIR/dsh-tui-config"
    grep -F "@dsh-tui/dsh-tui" "$TMPDIR/dsh-tui-config" >/dev/null
    grep -F "@deepseek-ai/dsh-llm-pi-ai" "$TMPDIR/dsh-tui-config" >/dev/null
    grep -F "@dsh-tui/providers" "$TMPDIR/dsh-tui-config" >/dev/null
    if grep -F "@deepseek-ai/dsh-web-app" "$TMPDIR/dsh-tui-config" >/dev/null; then
      echo "TUI profile contains the Web application bundle" >&2
      exit 1
    fi
    if "$out/bin/dsh-tui" >"$TMPDIR/dsh-tui.stdout" 2>"$TMPDIR/dsh-tui.stderr"; then
      echo "TUI unexpectedly started without terminal streams" >&2
      exit 1
    fi
    grep -F "ui-tui: both stdin and stdout must be TTYs" "$TMPDIR/dsh-tui.stderr" >/dev/null
    DSH_HOME="$TMPDIR/dsh-pty-home" TERM=xterm-256color \
      expect ${./tui-smoke.exp} "$out/bin/dsh-tui"
    DSH_HOME="$TMPDIR/dsh-provider-pty-home" TERM=xterm-256color \
      expect ${./provider-smoke.exp} "$out/bin/dsh-tui"

    runHook postInstallCheck
  '';

  passthru = { inherit pnpmDeps tui providers; };

  meta = {
    description = "Slim, source-built DeepSeek Harness terminal UI";
    homepage = "https://github.com/invaliddayta/dsh-tui-nix";
    license = with lib.licenses; [
      asl20
      bsd0
      bsd2
      bsd3
      isc
      lgpl3Plus
      mit
      psfl
    ];
    mainProgram = "dsh-tui";
    maintainers = [
      {
        name = "invaliddayta";
        github = "invaliddayta";
      }
    ];
    sourceProvenance = with lib.sourceTypes; [
      fromSource
      binaryNativeCode
    ];
    platforms = [
      "aarch64-linux"
      "x86_64-linux"
    ];
  };
})
