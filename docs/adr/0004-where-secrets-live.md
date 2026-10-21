# ADR 0004: Where secrets live, and what may decrypt them

Status: proposed, 2026-10-16

## Context

Lorehouse is meant to take requests like "run the benchmark and show me", "screenshot the
sign-up flow" or "make the first sign-up page ask for a username" in Slack, open a
sandbox, and do the work on its own. That needs more secrets than it holds today, and
they're more varied:

- Lorehouse's own: the Anthropic API key, the Slack bot token and signing secret, the
  GitHub App's private key, the runner token. Today all of them are Fly secrets or
  `settings.json` values, read into the process at start.
- A tenant's own, once Lorehouse is hosted: a customer's model key, and the secrets a
  customer's repo needs to run its app or tests in a sandbox (a test database URL, a
  third-party sandbox key).

Two rules are already in place. The model is called from Lorehouse, never from a
sandbox (`src/app.ts`, ADR 0003). And GitHub write access never enters a sandbox: the
host stages a bundle and pushes it after an Approve in the thread (#31, #32). The
sandbox is where untrusted code runs: the repo's own dependencies, model-written
commands, and whatever a Slack message or an indexed thread talked the model into.

[Strongroom](https://github.com/solcreek/strongroom) (0.1.0, 2026-10-13) encrypts
recoverable credentials under a managed KMS (Cloud KMS, AWS KMS, Vault, OpenBao) as
envelopes that the caller stores in its own database. `decrypt` returns the plaintext
to an authorized caller. Each Strongroom token is bound to one tenant. Lorehouse gives
each tenant a Strongroom deployment and KMS key of its own (ADR 0005 §2), which
solcreek/strongroom#12 makes the only form Strongroom accepts.

## Decision

1. **No secret enters a sandbox: not its environment, its disk, the golden, or a
   snapshot.** Code in the guest that needs a credential gets it on the wire. Under
   #110, the host's egress proxy adds the credential for the named host, and the guest
   sees a placeholder or nothing. Until #110 ships, a profile can't grant a sandbox
   any secret. Two exceptions remain today, and both go away:
   - **Clone and fetch.** `workspace_clone` puts a GitHub App installation token
     (read-only, one repo, about an hour) in the guest's environment for that one
     `git clone` or `git fetch` (`src/tools/clone.ts`), in normal App mode too.
     #110 moves this authentication to the proxy, so the guest's git talks to
     github.com with no credential of its own.
   - **Dev mode.** The `GITHUB_TOKEN` path (#77) is development only.

2. **Tenant secrets are Strongroom envelopes in `LOREHOUSE_DB`, not plaintext.** This
   covers a customer's model key and a repo's run and test secrets. The envelope
   context is `{tenantId, recordId: "<repo or install>/<name>", purpose}`, rebuilt at use
   time from trusted data (the install, the profile grant), never from model output.
   Lorehouse decrypts just before use:
   - a model key, for the model call;
   - a repo secret, to hand it to sandboxd's proxy for one sandbox's lifetime.

   Plaintext is never logged, stored or put in a tool result. Strongroom's own
   authorization doesn't replace Lorehouse's: Lorehouse must still check that the
   thread's install and profile may use that record.

3. **Signing keys that never need to leave KMS don't.** The GitHub App's private key is
   imported into Cloud KMS as an `RSA_SIGN_PKCS1_2048_SHA256` key. `appJwt` in
   `src/github-auth.ts` asks KMS to sign each JWT (`asymmetricSign`) instead of signing
   with a key in memory. The local copies are then deleted. Hosted, the key acts for
   every installation, so only the broker of ADR 0005 §4 may ask KMS to sign, and it
   mints installation tokens for the asking tenant only; no tenant's runtime holds the
   right to sign. A Strongroom envelope
   would be the wrong tool here: each decrypt puts the whole key back in Lorehouse's
   memory, and all GitHub needs is a signature. A `sign` operation in Strongroom is an
   option for later (it would carry tenant binding over), but it doesn't block this.

4. **Lorehouse authenticates to KMS and Strongroom without a static credential where its
   platform allows.** On Fly this means Fly's OIDC tokens (`oidc.fly.io`, the Machines
   API `/v1/tokens/oidc`) exchanged through GCP Workload Identity Federation. The
   Strongroom token stays a static bearer token for now: Strongroom has no OIDC
   caller auth. It is the one bootstrap secret. Each tenant has its own, for its own
   Strongroom deployment, and only that tenant's runtime holds it: it opens the
   tenant's data key, so it is kept like one, never in the control plane. A self-hosted
   install with no federation keeps today's env and `settings.json` path.

5. **Lorehouse's own single-instance secrets stay where they are.** The Anthropic key and
   the Slack tokens stay Fly secrets or `settings.json` values. Moving one key into
   Strongroom would only swap it for the Strongroom token, at the cost of a network
   dependency on every start. That changes once there are many tenants' keys (2).
   Hosted, the credentials that act for every tenant (Slack's signing secret,
   the Teams and Google Chat app credentials, the GitHub App key) stay with the edge and
   the broker, never in a tenant's runtime (ADR 0005 §4).

## Consequences

- #110 (egress proxy with credential injection) becomes a prerequisite for any
  profile that needs a repo secret, among them the "screenshot the app" milestone.
  Until then a sandbox gets no secret beyond the short-lived read token that clone
  and fetch use today (rule 1). Removing #77 alone doesn't close that gap: #110 has
  to take over clone and fetch authentication too.
- The GitHub App key leaves the Fly secrets, and an attacker with Lorehouse's process
  memory can no longer take it away. Whoever holds the broker's KMS access can still
  mint JWTs while they hold it; a tenant's runtime never does. Keys are generated by GitHub, never by us: GitHub Apps don't
  accept an externally generated public key
  ([managing private keys](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps)).
  Rotation is therefore:
  1. Generate a new key in the App's settings.
  2. Import it into KMS as a new key version, and delete the downloaded file.
  3. Verify that a JWT signed with it is accepted (`GET /app`), then switch the
     signer to it.
  4. Delete the old key in GitHub, so any surviving copy can no longer
     authenticate, and disable its KMS version.

  The first import works the same way, and the key file that is in the Fly
  secrets today is replaced by a freshly generated one.
- A Strongroom outage stops tenant-secret use (model calls on a customer key,
  sandboxes needing repo secrets). It doesn't stop Lorehouse's own key or the brain.
  Decrypt failures must surface as a clear thread message, not a retry storm.
- `lorehouse doctor` grows checks: KMS signing works, the Strongroom token is valid
  for its tenant, and no repo secret appears in a sandbox (a canary it greps for).
- Self-hosting stays possible without any cloud KMS. Rules 1 and 2 hold there through
  OpenBao Transit, which Strongroom supports, and rule 3 falls back to today's in-memory
  key, with a doctor warning.
