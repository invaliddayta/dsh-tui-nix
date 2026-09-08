{
  lib,
  stdenvNoCC,
  nodejs-slim_24,
  typescript,
  fetchFromGitHub,
}:
let
  upstream = fetchFromGitHub {
    owner = "ccch1mneyyy";
    repo = "dsh-TUI";
    rev = "9639f69b4cb2c3907844160094515e3970b55c8b";
    hash = "sha256-K0pIJ7HZasobofrl4KgxZJCEwy+n71O/A8sNw634Xd4=";
  };
in
stdenvNoCC.mkDerivation {
  pname = "dsh-tui-providers";
  version = "0.1.0";
  src = ./providers;
  nativeBuildInputs = [
    nodejs-slim_24
    typescript
  ];
  dontConfigure = true;
  buildPhase = ''
    runHook preBuild
    mkdir -p src node_modules
    mv *.ts src/
    ln -s ${typescript}/lib/node_modules/typescript node_modules/typescript
    node build.mjs ${upstream}
    tsc --noCheck --declaration --target es2024 --module nodenext \
      --outDir lib src/*.ts src/upstream/*.ts src/upstream/dsh-adapter/*.ts src/upstream/utils/*.ts
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    mkdir -p "$out/package" "$out/checks/scripts"
    cp -r lib package.json "$out/package/"
    cp -r src "$out/checks/"
    cp ${upstream}/LICENSE "$out/package/UPSTREAM-LICENSE"
    cp ${../LICENSE} "$out/package/LICENSE"
    cp ${upstream}/scripts/verify-provider-wizard.mjs "$out/checks/scripts/"
    runHook postInstall
  '';
  passthru = { inherit upstream; };
  meta = {
    description = "Native Harness authorization and upstream provider wizard for Pi-TUI";
    license = lib.licenses.mit;
    platforms = [
      "aarch64-linux"
      "x86_64-linux"
    ];
  };
}
