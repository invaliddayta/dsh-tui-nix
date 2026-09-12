{ lib, stdenvNoCC, nodejs-slim_24, typescript }:

stdenvNoCC.mkDerivation {
  pname = "dsh-credentials-opencode";
  version = "0.1.0";
  src = ../packages/credentials-opencode;
  nativeBuildInputs = [ nodejs-slim_24 typescript ];
  dontConfigure = true;
  buildPhase = ''
    runHook preBuild
    tsc --noCheck --declaration --target es2024 --module nodenext --outDir lib index.ts
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    mkdir -p "$out/package" "$out/checks"
    cp -r lib package.json README.md "$out/package/"
    cp ${../LICENSE} "$out/package/LICENSE"
    cp index.ts "$out/checks/"
    runHook postInstall
  '';
  meta = {
    description = "Optional read-only OpenCode credential provider for DeepSeek Harness";
    license = lib.licenses.mit;
    platforms = [ "aarch64-linux" "x86_64-linux" ];
  };
}
