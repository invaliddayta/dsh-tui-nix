{
  lib,
  stdenv,
  stdenvNoCC,
  nodejs-slim_24,
  pnpm_11,
  fetchPnpmDeps,
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
    currentLimit=$(ulimit -v)
    if [ "$currentLimit" = unlimited ] || [ "$currentLimit" -gt 10485760 ]; then
      ulimit -v 10485760
    fi
  '';
  projectRuntime = ''
    mkdir -p nix
    cp ${./project-tui-runtime.mjs} nix/project-tui-runtime.mjs
    cp ${./select-build-projects.mjs} nix/select-build-projects.mjs
    cp ${./build-missing-node-entries.mjs} nix/build-missing-node-entries.mjs
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
    hash = "sha256-vgsX2q1x8YCFw69sjqKOJx0Q4JWFvONq3agiScVM/fw=";
    env.NODE_OPTIONS = "--max-old-space-size=2048";
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
  env.pnpm_config_child_concurrency = 2;
  env.pnpm_config_network_concurrency = 8;

  preConfigure = ''
    ${limitBuildMemory}
    ${projectRuntime}
  '';

  buildPhase = ''
    runHook preBuild

    ${lib.getExe nodejs-slim_24} --input-type=module <<'EOF'
    import { readFileSync, writeFileSync } from 'node:fs'
    const packages = JSON.parse(readFileSync('nix/tui-runtime-workspaces.json', 'utf8'))
    packages.push({ name: '@deepseek-ai/dsh-typert-generator', path: 'packages/typert/generator' })
    writeFileSync('nix/tui-build-workspaces.json', JSON.stringify(packages))
    EOF

    export DSH_TSDOWN_FILTER=$(${lib.getExe nodejs-slim_24} --input-type=module <<'EOF'
    import { readFileSync } from 'node:fs'
    const packages = JSON.parse(readFileSync('nix/tui-runtime-workspaces.json', 'utf8'))
    const names = packages.map(({ name }) => name.replace(/[|\\{}()[\]^$+*?.-]/g, '\\$&'))
    if (names.length === 0) throw new Error('TUI runtime package set is empty')
    process.stdout.write(`^(?:''${names.join('|')})$`)
    EOF
    )

    ${lib.getExe nodejs-slim_24} \
      nix/select-build-projects.mjs \
      nix/tui-build-workspaces.json tsconfig.host.json nix/tui-host-projects.txt
    mapfile -t buildProjects < nix/tui-host-projects.txt
    if [ "''${#buildProjects[@]}" -eq 0 ]; then
      echo "TUI host TypeScript project set is empty" >&2
      exit 1
    fi
    ${lib.getExe nodejs-slim_24} --max-old-space-size=4096 \
      ./node_modules/typescript/bin/tsc -b "''${buildProjects[@]}"

    DSH_BUILD_FACE=host ${lib.getExe nodejs-slim_24} --input-type=module <<'EOF'
    import { readFileSync } from 'node:fs'
    import { build } from 'tsdown'
    const packages = JSON.parse(readFileSync('nix/tui-runtime-workspaces.json', 'utf8'))
    await build({
      env: { DSH_BUILD_FACE: 'host' },
      filter: new RegExp(process.env.DSH_TSDOWN_FILTER),
      workspace: packages.map(({ path }) => path).filter(path => !path.startsWith('native/')),
    })
    EOF

    ${lib.getExe nodejs-slim_24} nix/build-missing-node-entries.mjs

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

    mkdir -p "$out/libexec/dsh/node_modules/@dsh-tui"
    cp -a ${tui}/package "$out/libexec/dsh/node_modules/@dsh-tui/dsh-tui"

    mkdir -p "$out/share/dsh/profiles/${profileName}"
    cp -r ${./tui-profile}/. "$out/share/dsh/profiles/${profileName}/"

    licenseDir="$out/share/licenses/deepseek-harness-tui"
    mkdir -p "$licenseDir"
    cp ${../LICENSE} "$licenseDir/PACKAGING-LICENSE"
    cp ${harness-src}/LICENSE "$licenseDir/DEEPSEEK-HARNESS-LICENSE"
    cp ${harness-src}/THIRD_PARTY_NOTICES.md "$licenseDir/THIRD_PARTY_NOTICES.md"
    cp ${dsh-tui-src}/LICENSE "$licenseDir/DSH-TUI-LICENSE"

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
    runHook preInstallCheck

    test "$("$out/libexec/dsh/bin/dsh" --version)" = "${finalAttrs.version}"
    test ! -e "$out/libexec/dsh/node_modules/@deepseek-ai/dsh-web-app"
    test ! -e "$out/libexec/dsh/node_modules/@deepseek-ai/dsh-web-frontend"
    test ! -e "$out/libexec/dsh/node_modules/@deepseek-ai/dsh-host-webserver"
    test ! -e "$out/libexec/dsh/node_modules/@deepseek-ai/dsh-terminal-bash"
    test ! -e "$out/libexec/dsh/node_modules/@deepseek-ai/dsh-api-gateway"
    test ! -e "$out/libexec/dsh/node_modules/@deepseek-ai/dsh-command-feedback"
    test ! -e "$out/libexec/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai"
    test ! -e "$out/libexec/dsh/node_modules/@deepseek-ai/dsh-session-telemetry-otel"
    test ! -e "$out/libexec/dsh/node_modules/@earendil-works/pi-ai"
    test ! -e "$out/libexec/dsh/node_modules/@opentelemetry"
    test ! -e "$out/libexec/dsh/node_modules/express"
    test ! -e "$out/libexec/dsh/node_modules/hono"
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
    if grep -F "@deepseek-ai/dsh-web-app" "$TMPDIR/dsh-tui-config" >/dev/null; then
      echo "TUI profile contains the Web application bundle" >&2
      exit 1
    fi
    if "$out/bin/dsh-tui" >"$TMPDIR/dsh-tui.stdout" 2>"$TMPDIR/dsh-tui.stderr"; then
      echo "TUI unexpectedly started without terminal streams" >&2
      exit 1
    fi
    grep -F "ui-tui: both stdin and stdout must be TTYs" "$TMPDIR/dsh-tui.stderr" >/dev/null
    expect <<EOF
    set timeout 20
    spawn sh -c "stty rows 24 cols 80; exec env DSH_HOME=$TMPDIR/dsh-pty-home TERM=xterm-256color $out/bin/dsh-tui"
    expect {
      -re {main-session-} {
        after 1000
        send "/model"
        after 100
        send "\r"
        expect {
          -re {Select model} {
            send "\033"
            after 200
            send "\003"
            expect {
              eof {}
              timeout {
                puts stderr "TUI did not exit after Ctrl-C"
                exit 1
              }
            }
          }
          -re {Command failed} {
            puts stderr "TUI model command failed"
            exit 1
          }
          timeout {
            puts stderr "TUI model selector did not open"
            exit 1
          }
        }
      }
      timeout {
        puts stderr "TUI did not render inside a pseudo-terminal"
        exit 1
      }
      eof {
        puts stderr "TUI exited before rendering inside a pseudo-terminal"
        exit 1
      }
    }
    EOF

    runHook postInstallCheck
  '';

  passthru = { inherit pnpmDeps tui; };

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
