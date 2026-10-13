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
  [`AGENTS.md`](../AGENTS.md). Nothing in the app needs Node: `start`, `test`,
  `conformance`, `build` and `doctor` run on Bun's own runtime. `typecheck` is `tsc`,
  whose `#!/usr/bin/env node` shebang `bun run` honors: it runs under the first `node`
  on the `PATH`, or under Bun when there is none.
- **Run everything through `bun`, not `node`/`npx`.** A Mac with both nvm and Homebrew
  Node can have two Node ABIs on the `PATH` (`node` from one, `#!/usr/bin/env node` from
  the other), and a test run under the wrong one fails with `NODE_MODULE_VERSION`
  mismatches that look like regressions. The Bun-native scripts sidestep that; `tsc` (TypeScript 7)
  only launches TypeScript's own executable, not a Node addon, so either Node runs it the same.
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

### Not proven yet

On Render and Railway only the container side is proven: the image runs, listens on the
host's `PORT`, passes `/healthz`, and keeps `/data` across a redeploy. Every run had no
Slack or Anthropic secrets, so Lorehouse sat in setup mode. Nothing yet shows, on either
host:

- that it answers Slack: a mention arrives through the host's proxy and gets a streamed
  reply within Slack's 3 s
- the backfill writing the SQLite files to the disk, and a restart reconciling from them
  ([live-slack.md](live-slack.md) §4, items 1 and 9)
- a sandbox runner connecting in through the host's proxy (WebSocket or long poll)

To prove it, create a second Slack app from [`slack/manifest.yaml`](../slack/manifest.yaml)
for a test channel, rather than pointing production's app at the new host, which would
take production off Slack while it ran. Deploy with that app's secrets, run
`lorehouse doctor --url <host URL>`, then the checks in [live-slack.md](live-slack.md) §4.
Record the run here with its date, and change the host's row in the README.

Fly.io is proven against real Slack: it is production.

### Render

The [`render.yaml`](../render.yaml) Blueprint (New → Blueprint, this repository) creates
the service and its disk together, and asks for the secrets. The workspace needs a
payment method first: `render blueprints validate render.yaml` says `need_payment_info`
until it has one, because a disk needs a paid instance type.

The same from the CLI and the API, for an install an agent drives:

```bash
render services create --name lorehouse --type web_service --runtime image \
  --image ghcr.io/solcreek/lorehouse:latest --plan starter --region <region> \
  --health-check-path /healthz --env-var SLACK_SIGNING_SECRET=… --env-var … -o json --confirm
# once its first deploy is live (a disk can't be added while one is pending):
curl -X POST https://api.render.com/v1/disks -H "Authorization: Bearer $RENDER_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"name":"lorehouse-data","mountPath":"/data","sizeGB":1,"serviceId":"srv-…"}'
```

The CLI has no flag for a disk, and its login doesn't work as an API key: create one
under Account Settings → API Keys.

Proven on 2026-10-12, without Slack secrets (so in setup mode): a starter service in
Singapore pulled `:latest`, listened on Render's `PORT` (10000) and passed `/healthz`, and
a file written to `/data` was still there after a redeploy onto a new instance. Not yet
proven: a full install answering Slack on Render.

Two things that differ from Fly:

- **Shell access**: `render ssh` works only in an interactive terminal. Plain `ssh
  srv-…@ssh.<region>.render.com` works once your key is under Account Settings → SSH
  Public Keys, but needs `-tt`, or a command runs and prints nothing.
- **Start command**: on an image service, a Docker Command of `/bin/sh -c "…"` (or the
  other quotings tried) ran with `$(…)` and `;` as literal text, not as shell syntax.
  Leave it empty; the image's own command starts Lorehouse.

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
replica. Railway needs a paid plan once the trial ends: `railway init` refuses with
"Your trial has expired".

Proven on 2026-10-12 on the Hobby plan, without Slack secrets (so in setup mode): these
steps pulled `:latest`, Lorehouse listened on Railway's `PORT` (8080) and passed
`/healthz`, and a file written to `/data` was still there after a redeploy onto a new
container. Not yet proven: a full install answering Slack on Railway.

**Shell access**: `railway ssh <command>` ran but printed nothing. Register a key
(`railway ssh keys add`), write an OpenSSH block with `railway ssh config --alias
lorehouse`, then `ssh -tt lorehouse '<command>'`. It needs v0.1.1 or later: Railway's SSH,
like Fly's, fails (exit 125) on an image without an `/etc/passwd` root user.
