# The Bun every Nix output builds and runs with, pinned to the same exact version as
# the Dockerfile and CI's setup-bun steps. nixpkgs' own bun trails upstream releases, so
# this overrides its version and per-system downloads; the build is otherwise nixpkgs'.
# To move it: change `version` here and in those places, and take each hash from
# `nix store prefetch-file <url>` (it matches the release's SHASUMS256.txt).
{ pkgs }:
pkgs.bun.overrideAttrs (
  finalAttrs: old: {
    version = "1.4.3";
    # nixpkgs takes src from passthru.sources already; naming it here says so, and keeps
    # nixpkgs from warning that the version moved without it.
    src = finalAttrs.passthru.sources.${pkgs.stdenvNoCC.hostPlatform.system};
    passthru = old.passthru // {
      sources = {
        "aarch64-darwin" = pkgs.fetchurl {
          url = "https://github.com/oven-sh/bun/releases/download/bun-v${finalAttrs.version}/bun-darwin-aarch64.zip";
          hash = "sha256-gK/UwGm0am+o8+xSC+vHUKeEPkqNW5WD0prUNsAKNAM=";
        };
        "aarch64-linux" = pkgs.fetchurl {
          url = "https://github.com/oven-sh/bun/releases/download/bun-v${finalAttrs.version}/bun-linux-aarch64.zip";
          hash = "sha256-76mBPaXtckI7+Ef5FujSxHwNd2rdlyNUAmp14Q2pqiE=";
        };
        # The baseline build, as nixpkgs uses: it runs on x86_64 CPUs without AVX2.
        "x86_64-linux" = pkgs.fetchurl {
          url = "https://github.com/oven-sh/bun/releases/download/bun-v${finalAttrs.version}/bun-linux-x64-baseline.zip";
          hash = "sha256-H8LtrIQxApCeOhvh2NmALMYHHPB05n6IIx9P/g+LOXs=";
        };
      };
    };
  }
)
