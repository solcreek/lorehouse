# `nix develop`: everything CI uses to build and check Lorehouse, its sandbox and the
# website. `nix develop .#deploy` adds the CLIs of the hosts it can deploy to.
{ pkgs }:
let
  inherit (pkgs) lib stdenv;
  pinnedBun = import ./bun.nix { inherit pkgs; };
  # On Linux the SQLite driver's prebuilt addon (src/sqlite.ts) needs libstdc++.so.6,
  # which the Nix bun's loader looks for only in the store: this bun, and what it runs,
  # find nixpkgs'. (The built binary has it patched in instead; nix/packages.nix.)
  bun =
    if stdenv.hostPlatform.isLinux then
      pkgs.symlinkJoin {
        name = "bun-${pinnedBun.version}";
        paths = [ pinnedBun ];
        nativeBuildInputs = [ pkgs.makeWrapper ];
        postBuild = "wrapProgram $out/bin/bun --prefix LD_LIBRARY_PATH : ${lib.getLib stdenv.cc.cc}/lib";
      }
    else
      pinnedBun;
  build = [
    bun
    pkgs.go
    pkgs.cargo
    pkgs.rustc
    pkgs.clippy
    pkgs.rustfmt
    pkgs.sqlite
    pkgs.jq
    pkgs.openssl
    pkgs.gh
    pkgs.cloudflared
  ];
  deploy = [
    pkgs.flyctl
    pkgs.railway
    pkgs.render-cli
    pkgs.wrangler
    pkgs.skopeo
  ];
in
{
  default = pkgs.mkShell { packages = build ++ [ pkgs.flyctl ]; };
  deploy = pkgs.mkShell { packages = build ++ deploy; };
}
