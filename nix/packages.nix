# The build outputs. `lorehouse` is the same single binary `bun run build` makes, with
# prompts, migrations and the Slack manifest compiled in; `image` wraps it for container
# hosts.
{ pkgs, self }:
let
  inherit (pkgs) lib stdenv;
  version = "0.0.0-${self.shortRev or self.dirtyShortRev or "dirty"}";

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
      pkgs.bun
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
        x86_64-linux = "sha256-8gO6aqdWwZP71NJx4pr+HitB7gSKHOOnj6YObd9yawA=";
        aarch64-linux = "sha256-AJ4+RWDK+xh4qYOsGyXy2J7Ls8xhjv7pc3hP0zwcemA=";
        aarch64-darwin = "sha256-nGXL2vgmQalRlnM+kt3VDC42wcgiK2v7XRkZkqXvinI=";
      }
      .${stdenv.hostPlatform.system};
  };

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
    nativeBuildInputs = [ pkgs.bun ];
    dontConfigure = true;
    buildPhase = ''
      runHook preBuild
      export HOME=$TMPDIR
      # A copy, not a symlink: bun resolves from the real path, which has no node_modules above it.
      cp -R ${nodeModules} node_modules && chmod -R u+w node_modules
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
      pkgs.bun
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
  # root: Fly's SSH server refuses every login without one.
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
        "LOREHOUSE_DB=/data/lorehouse.db"
        "SESSIONS_DB=/data/sessions.db"
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
