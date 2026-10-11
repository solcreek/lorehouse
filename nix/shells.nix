# `nix develop`: everything CI uses to build and check Lorehouse, its sandbox and the
# website. `nix develop .#deploy` adds the CLIs of the hosts it can deploy to.
{ pkgs }:
let
  build = [
    pkgs.bun
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
