# Lorehouse with Nix: the dev shell, the binaries and the container image, pinned by
# flake.lock so a laptop, CI and every host build the same thing.
#
#   nix develop                    # bun, go, rust, sqlite, flyctl, cloudflared, …
#   nix develop .#deploy           # the above plus railway, render and wrangler
#   nix build                      # → result/bin/lorehouse
#   nix build .#image              # → an OCI image tarball (Linux systems only)
#
# The image is what every container host runs (Fly, Render, Railway, Cloudflare
# Containers); see docs/nix.md.
{
  description = "Lorehouse: an open-source company brain that lives in Slack";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      # No x86_64-darwin: nixpkgs dropped it in 26.11. Intel Macs use bun directly;
      # see docs/nix.md.
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAllSystems (pkgs: import ./nix/packages.nix { inherit pkgs self; });

      devShells = forAllSystems (pkgs: import ./nix/shells.nix { inherit pkgs; });

      checks = forAllSystems (
        pkgs:
        let
          packages = self.packages.${pkgs.stdenv.hostPlatform.system};
        in
        {
          inherit (packages) lorehouse;
          conformance = packages.conformance;
        }
        // nixpkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
          inherit (packages) image sandboxd sandbox-guest;
        }
      );

      formatter = forAllSystems (pkgs: pkgs.nixfmt-tree);
    };
}
