# The build outputs. `lorehouse` is the same single binary `bun run build` makes, with
# prompts, migrations and the Slack manifest compiled in; `image` wraps it for container
# hosts.
{ pkgs, self }:
let
  inherit (pkgs) lib stdenv;
  version = "0.0.0-${self.shortRev or self.dirtyShortRev or "dirty"}";
  bun = import ./bun.nix { inherit pkgs; };

  # bun.lock lists native packages for every platform; install only this one's, so the
  # output (and its hash) depends on the target, not on the machine that fetched it.
  bunTarget =
    {
      x86_64-linux = {
        os = "linux";
        cpu = "x64";
      };
      aarch64-linux = {
        os = "linux";
        cpu = "arm64";
      };
      aarch64-darwin = {
        os = "darwin";
        cpu = "arm64";
      };
    }
    .${stdenv.hostPlatform.system};

  # The dependencies, fetched once with network access and pinned by hash. When bun.lock
  # changes, the build fails with the new hash; paste it here (see docs/nix.md).
  nodeModules = stdenv.mkDerivation {
    # No commit in the name: the same bun.lock is the same store path on every commit.
    pname = "lorehouse-node-modules";
    version = "0";
    src = lib.fileset.toSource {
      root = ../.;
      fileset = lib.fileset.unions [
        ../package.json
        ../bun.lock
      ];
    };
    nativeBuildInputs = [
      bun
      pkgs.cacert
    ];
    dontConfigure = true;
    buildPhase = ''
      runHook preBuild
      export HOME=$TMPDIR BUN_INSTALL_CACHE_DIR=$TMPDIR/bun-cache
      bun install --frozen-lockfile --ignore-scripts --no-progress \
        --os=${bunTarget.os} --cpu=${bunTarget.cpu}
      runHook postBuild
    '';
    installPhase = ''
      runHook preInstall
      cp -R node_modules $out
      runHook postInstall
    '';
    dontFixup = true;
    outputHashMode = "recursive";
    outputHashAlgo = "sha256";
    outputHash =
      {
        x86_64-linux = "sha256-ZmALBK9HqmwpxbA8DU7/KoPi1uW8hlzGe1kjEKtgl3M=";
        aarch64-linux = "sha256-bEiDglaSF7+4OkjNLMAp9aK+vJjewF+z6fsrI0cp9Vc=";
        aarch64-darwin = "sha256-oTy3oVUvGnXrXe/e/zrOld4hW6ioPlwCX+9syWW5YSY=";
      }
      .${stdenv.hostPlatform.system};
  };

  # The SQLite driver's prebuilt addon (src/sqlite.ts) needs libstdc++.so.6, and the Nix
  # bun's loader looks for it only in the store. Give the addon a RUNPATH to nixpkgs'
  # before `bun build --compile` embeds it: that store path, inside the binary, makes this
  # libstdc++ part of the binary's closure, and so of the image.
  patchSqliteAddon = lib.optionalString stdenv.hostPlatform.isLinux ''
    patchelf --add-rpath ${lib.getLib stdenv.cc.cc}/lib \
      node_modules/better-sqlite3-multiple-ciphers/prebuilds/${bunTarget.os}-${bunTarget.cpu}.node
  '';

  # Only what the binary is built from; editing docs or tests doesn't rebuild it.
  appSrc = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../package.json
      ../tsconfig.json
      ../src
      ../prompts
      ../migrations
      ../slack
    ];
  };

  lorehouse = stdenv.mkDerivation {
    pname = "lorehouse";
    inherit version;
    src = appSrc;
    nativeBuildInputs = [ bun ] ++ lib.optional stdenv.hostPlatform.isLinux pkgs.patchelf;
    dontConfigure = true;
    buildPhase = ''
      runHook preBuild
      export HOME=$TMPDIR
      # A copy, not a symlink: bun resolves from the real path, which has no node_modules above it.
      cp -R ${nodeModules} node_modules && chmod -R u+w node_modules
      ${patchSqliteAddon}
      bun build --compile --minify ./src/server.ts --outfile dist/lorehouse
      runHook postBuild
    '';
    installPhase = ''
      runHook preInstall
      install -Dm755 dist/lorehouse $out/bin/lorehouse
      runHook postInstall
    '';
    # The bundle is appended to the bun executable: stripping or patching it breaks it.
    dontStrip = true;
    dontPatchELF = true;
    meta = {
      description = "An open-source company brain that lives in your team's public Slack channels";
      homepage = "https://github.com/solcreek/lorehouse";
      license = lib.licenses.mit;
      mainProgram = "lorehouse";
    };
  };

  # The behavioral contract against the binary Nix built, as CI runs it against
  # `bun run build`'s.
  conformance = stdenv.mkDerivation {
    pname = "lorehouse-conformance";
    inherit version;
    src = lib.fileset.toSource {
      root = ../.;
      fileset = lib.fileset.unions [
        ../package.json
        ../tsconfig.json
        ../conformance
        ../src
        ../prompts
        ../migrations
        ../slack
      ];
    };
    # lsof: the suite checks that the port it tests is held by the app it started.
    nativeBuildInputs = [
      bun
      pkgs.lsof
    ];
    dontConfigure = true;
    buildPhase = ''
      runHook preBuild
      export HOME=$TMPDIR
      # A copy, not a symlink: bun resolves from the real path, which has no node_modules above it.
      cp -R ${nodeModules} node_modules && chmod -R u+w node_modules
      bun conformance/run.ts --app ${lorehouse}/bin/lorehouse
      runHook postBuild
    '';
    installPhase = "touch $out";
  };

  # The container image every host runs. Same contract as the Dockerfile: the binary,
  # TLS roots, port 3000, and everything it keeps under /data (mount a volume there).
  # A busybox shell is in it for `fly ssh console` and the like, and an /etc/passwd with
  # root: Fly's SSH server refuses every login without one, and Railway's exits 125.
  image = pkgs.dockerTools.buildLayeredImage {
    name = "lorehouse";
    tag = "latest";
    contents = [
      lorehouse
      pkgs.cacert
      pkgs.busybox
      pkgs.dockerTools.fakeNss
    ];
    extraCommands = ''
      mkdir -p data tmp
      chmod 1777 tmp
    '';
    config = {
      Cmd = [ "${lorehouse}/bin/lorehouse" ];
      Env = [
        "PORT=3000"
        # The volume is the data directory: settings.json in it, the tenant's databases in
        # /data/<tenant>/ (src/tenant.ts). Images that set LOREHOUSE_DB and SESSIONS_DB
        # kept them in /data itself: the first start of this one moves them (by link and rename), and
        # leaves a symlink at each old path, so rolling back to such an image still works.
        "LOREHOUSE_DATA_DIR=/data"
        "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
        # So `lorehouse doctor` and the shell resolve in `fly ssh console` and the like.
        "PATH=/bin"
      ];
      ExposedPorts."3000/tcp" = { };
      Volumes."/data" = { };
      # The source label links the package on ghcr.io to this repository.
      Labels = {
        "org.opencontainers.image.source" = "https://github.com/solcreek/lorehouse";
        "org.opencontainers.image.description" = lorehouse.meta.description;
        "org.opencontainers.image.licenses" = "MIT";
        "org.opencontainers.image.revision" = self.rev or "dirty";
      };
    };
  };

  # The sandbox host daemon and the in-VM agent. Both need Linux (KVM, vsock).
  sandboxd = pkgs.rustPlatform.buildRustPackage {
    pname = "sandboxd";
    inherit version;
    src = lib.fileset.toSource {
      root = ../sandbox/host;
      fileset = lib.fileset.unions [
        ../sandbox/host/Cargo.toml
        ../sandbox/host/Cargo.lock
        ../sandbox/host/src
        # The unit and the host settings: the tests check them (src/service_unit.rs).
        ../sandbox/host/sandboxd.service
        ../sandbox/host/sandboxd.sysctl.conf
        ../sandbox/host/sandboxd.modules.conf
      ];
    };
    cargoLock.lockFile = ../sandbox/host/Cargo.lock;
    # publish.rs runs git: its tests need it, and so does the daemon at run time.
    nativeCheckInputs = [ pkgs.git ];
    nativeBuildInputs = [ pkgs.makeWrapper ];
    postFixup = "wrapProgram $out/bin/sandboxd --prefix PATH : ${lib.makeBinPath [ pkgs.git ]}";
    meta.platforms = lib.platforms.linux;
    meta.mainProgram = "sandboxd";
  };

  sandbox-guest = pkgs.buildGoModule {
    pname = "guestd";
    inherit version;
    src = lib.fileset.toSource {
      root = ../sandbox/guest;
      fileset = lib.fileset.fileFilter (
        f: f.hasExt "go" || f.name == "go.mod" || f.name == "go.sum"
      ) ../sandbox/guest;
    };
    vendorHash = "sha256-Bqs0iBvdK7BeEPf1CuoyHFmFPpXuChAJLqaCW3wi35E=";
    env.CGO_ENABLED = "0";
    postInstall = "mv $out/bin/guest $out/bin/guestd";
    meta.platforms = lib.platforms.linux;
    meta.mainProgram = "guestd";
  };
in
{
  default = lorehouse;
  inherit
    lorehouse
    conformance
    sandboxd
    sandbox-guest
    ;
  node-modules = nodeModules;
}
// lib.optionalAttrs stdenv.hostPlatform.isLinux { inherit image; }
