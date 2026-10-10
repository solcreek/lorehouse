# Nix

[`flake.nix`](../flake.nix) pins every tool Lorehouse is built and checked with, and
builds the same binary and container image on a laptop, in CI and on any host. It
doesn't replace `bun install` / `bun run build` or the [`Dockerfile`](../Dockerfile);
those keep working. It's there so that a new machine, a new contributor or a new host
gets the same toolchain in one command.

It covers Linux (x86_64 and arm64) and Apple Silicon Macs.

### Intel Macs (`x86_64-darwin`) aren't supported

nixpkgs dropped `x86_64-darwin` in 26.11: it no longer builds packages for it or
supports building them from source (`doc/release-notes/rl-2611.section.md`). The
`nixos-unstable` this flake pins is past that, so there is no toolchain to pin, and
`nix develop` / `nix build` on an Intel Mac have no outputs to use. The 26.05 stable
branch still carries the platform, but only until it goes out of support at the end of
2026, so it isn't worth pinning a second nixpkgs for.

On an Intel Mac, work without Nix:

- **Bun from Homebrew** (`brew install bun`) or the official installer
  (`curl -fsSL https://bun.sh/install | bash`). Then `bun install`, `bun run typecheck`,
  `bun run test`, `bun run conformance`, `bun run build`, as in
  [`AGENTS.md`](../AGENTS.md). All of these run on Bun; nothing in the app needs Node.
- **Run everything through `bun`, not `node`/`npx`.** A Mac with both nvm and Homebrew
  Node can have two Node ABIs on the `PATH` (`node` from one, `#!/usr/bin/env node` from
  the other), and a test run under the wrong one fails with `NODE_MODULE_VERSION`
  mismatches that look like regressions. `bun run …` uses Bun's own runtime and
  sidesteps that.
- **The sandbox** (`sandbox/guest`, `sandbox/host`) needs Linux (KVM, vsock) to run on
  any Mac; work on it on a Linux machine, where the flake applies.
- **The container image**: the [`Dockerfile`](../Dockerfile), or `nix build .#image` on
  a Linux machine. CI builds and publishes it either way.

## Develop

```bash
nix develop            # bun, go, cargo/rustc/clippy, sqlite, jq, gh, cloudflared, flyctl
nix develop .#deploy   # the above plus railway, render, wrangler and skopeo
```

Then the usual `bun install`, `bun run test`, `bun run conformance` and so on.

## Build

| output | what |
|---|---|
| `nix build` (`.#lorehouse`) | the single binary, as `bun run build` makes it → `result/bin/lorehouse` |
| `nix build .#image` | the container image, as a tarball for `docker load` (Linux only) |
| `nix build .#conformance` | the conformance suite against that binary |
| `nix build .#sandboxd` `.#sandbox-guest` | the sandbox host daemon and `guestd` (Linux only) |
| `nix flake check` | all of the above for this system |

The image matches the Dockerfile's: the binary, TLS roots, `PORT=3000`, and the SQLite
files under `/data`. It adds a busybox shell for `fly ssh console` and the like.

On a Mac, `.#image` needs a Linux builder (for example Determinate Nix's native Linux
builder, or a remote builder). CI builds it on every change, on x86_64 and arm64, runs
it, and waits for `/healthz`.

The Nix-built binary links against the Nix store, so it runs where Nix (or the image)
is. The portable binaries `install.sh` downloads still come from `release.yml`.

## When `bun.lock` or `go.sum` changes

The dependencies are fetched once and pinned by hash in
[`nix/packages.nix`](../nix/packages.nix): `nodeModules.outputHash` (one per system,
since `bun.lock` has native packages per platform) and `sandbox-guest.vendorHash`. After
a lockfile change the build fails with:

```
error: hash mismatch in fixed-output derivation '…-lorehouse-node-modules-0.drv':
         specified: sha256-…
            got:    sha256-…
```

Paste the `got:` hash in. To get every system's node_modules hash without a builder
for each, run the same install in a scratch directory and hash it:

```bash
for t in linux:x64 linux:arm64 darwin:arm64; do
  d=$(mktemp -d); cp package.json bun.lock "$d"
  (cd "$d" && HOME=$d bun install --frozen-lockfile --ignore-scripts --os=${t%:*} --cpu=${t#*:} >/dev/null)
  echo "$t $(nix hash path "$d/node_modules")"
done
```

`nix flake update` moves nixpkgs (and with it bun, go and rust) forward; run
`nix flake check` before committing the new `flake.lock`.

## Hosts

CI publishes the image to `ghcr.io/solcreek/lorehouse` for x86_64 and arm64:

| tag | when |
|---|---|
| `:sha-<commit>` | every merge to `main` that passes the contract |
| `:main` | the same, if that commit is still `main`'s head when its image is published, so it never moves back to an older commit. A merge that lands meanwhile and then fails leaves `:main` behind until the next one passes |
| `:vX.Y.Z` | every release tag |
| `:latest` | the highest `vX.Y.Z`: a backport or a pre-release (`-rc.1`) doesn't move it |

The hosts below pull it without credentials, so the package must be public. A new
package on ghcr.io can start out private: after the first publish, check from a machine
that isn't logged in to ghcr.io,

```bash
docker pull ghcr.io/solcreek/lorehouse:main
```

and if it is refused, open the package from the repository's **Packages** sidebar →
**Package settings** → **Change visibility** → Public. A fork that publishes its own
image does the same for its package.

That image is the unit every container host runs. What each one needs beyond it:

| host | how | the SQLite files |
|---|---|---|
| **Fly.io** | [`fly.toml`](../fly.toml) runs `:main` (`:latest` for your own install); CI deploys each merge's `:sha-<commit>` | a volume at `/data` |
| **Render** | the [`render.yaml`](../render.yaml) Blueprint: a web service from the image, on a paid instance type | a disk at `/data`, in the Blueprint |
| **Railway** | the CLI, below | a volume at `/data` |
| **Cloudflare Containers** | ✗ | the container's disk doesn't survive a restart, so the SQLite files would be lost. Cloudflare stays on the Workers route in the README |
| **Linux you run** | the release binary under systemd (`install.sh`), or the image | a local directory |

Every one of them is a single always-on instance (Lorehouse holds a SQLite file and has
to answer Slack within 3 s), with the secrets from the README as environment variables.
Render and Railway set `PORT` themselves; Lorehouse listens on it.

### Railway

```bash
railway init --name lorehouse
railway add --service lorehouse --image ghcr.io/solcreek/lorehouse:latest \
  --variables "SLACK_SIGNING_SECRET=…" --variables "SLACK_BOT_TOKEN=…" \
  --variables "ANTHROPIC_API_KEY=…" --variables "AGENT_CHANNELS=C0123456" \
  --variables "STATUS_TOKEN=$(openssl rand -hex 32)"
railway service link lorehouse
railway volume add --mount-path /data
railway domain                  # the public URL to give Slack
```

In the service's settings, set the healthcheck path to `/healthz` and keep it at one
replica.
