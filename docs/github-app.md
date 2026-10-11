# GitHub access: a GitHub App

The code tools reach GitHub as a GitHub App, not as a person. The App belongs to the
organization, pull requests are opened by the App's bot, and Lorehouse never
holds a long-lived token:

- For every repo it needs, Lorehouse signs a JWT with the App's private key and trades it
  for an installation token that lasts an hour and covers **that one repo**.
- Cloning asks for `contents: read`. Pushing a branch and opening a pull request asks for
  `contents: write` and `pull_requests: write`, and only after someone approves the pull
  request in Slack.
- **A write token never enters the sandbox.** The sandbox host publishes instead (see
  [Publishing](sandbox-runners.md#publishing)):
  - Before approval, it stages the commits. It verifies them into its own mirror of the
    repo, and computes the diff, patch and authors the approval card shows. None of that
    comes from the sandbox's git, which the model controls.
  - After approval, the host pushes exactly the staged commit with the write token.
- The read token for cloning does enter the sandbox, for the clone or fetch command only.
  - It travels through a credential helper, in that one command's environment; it is never
    in the command line or the remote URL.
  - The command runs with hooks off and every other credential helper dropped, and the
    helper answers only for `https://github.com`.
  - What that can't stop is code run earlier in the sandbox replacing `git` itself. The
    exposure is read access to one repo for an hour: code the sandbox could read anyway.
- Commits are by the App's bot too, `<app>[bot]` at its noreply address, so GitHub links
  each commit to the bot. Every command the agent runs has git's author and committer
  set to it (they outrank any git config), and a pull request whose commits are by
  anyone else is sent back to be re-authored before anyone is asked to approve it.
  If GitHub can't be reached to look the bot up, commands still run (with git's own
  configuration), but no pull request goes out: the check before approval fails
  closed, and the agent is told to try again.
- Which repos the agent can touch is decided on GitHub: the repos the App is installed on.
  A repo it isn't installed on can still be cloned if it is public, and never pushed to.

## Setting it up

1. On GitHub: the organization's **Settings → Developer settings → GitHub Apps → New
   GitHub App**.
   - Name: anything, e.g. your agent's name. It is the bot's name on pull requests.
   - Homepage URL: your Lorehouse URL (required by the form, not used).
   - Webhook: **off** (uncheck *Active*). Lorehouse only calls GitHub.
   - Repository permissions: **Contents: Read and write**, **Pull requests: Read and
     write**. Metadata: read-only is added automatically. Nothing else.
   - Where can this App be installed: **Only on this account**.
2. Create it. Note the **App ID** on its page.
3. **Private keys → Generate a private key**. A `.pem` file downloads. It is the App's
   password: keep it out of the repo and out of chat.
4. **Install App** → your organization → **Only select repositories** → the repos the
   agent may work on. Add more later from the same page. Choosing a repo here lets
   anyone in the agent's channels read it, private or not: see
   [What installing on a repository allows](#what-installing-on-a-repository-allows).
5. Give Lorehouse both, e.g. on Fly.io:

   ```sh
   fly secrets set GITHUB_APP_ID=123456 --stage
   fly secrets set GITHUB_APP_PRIVATE_KEY="$(cat path/to/app.private-key.pem)" --stage
   ```

   The key can also be given with its newlines escaped as `\n` (one line); Lorehouse
   restores them.

The App needs a sandbox to be useful: set it together with `SANDBOX_RUNNER_TOKEN` (or
`SANDBOX_URL` + `SANDBOX_TOKEN`). Lorehouse refuses to start with GitHub credentials and
no sandbox, and with both an App and `GITHUB_TOKEN`.

## What installing on a repository allows

Installing the App on a repository is the authorization to read it. There is no
further approval step for reading:

- **Who**: anyone who can ask the agent, which is anyone in a channel listed in
  `AGENT_CHANNELS`. List only public channels there: a private one listed would be
  answered too. An empty list means nowhere: no mention or follow-up is answered in any
  channel, and the next start forgets the threads it was asked into. With the code tools on,
  a DM never reaches the model (`DM_MODE=answer` and a sandbox are refused together).
- **What**: the whole contents of any repository the App is installed on, **private
  repositories included**. `workspace_clone` asks for a read-only token (`contents:
  read`, that one repo, expiring within the hour) and clones or fetches with it, without
  asking anyone. A public repository the App isn't installed on is cloned anyway,
  anonymously.
- **Where it shows**: in the thread the agent answers in. Whatever the agent reads from
  the checkout (a file, a diff, test output) it can quote there, and everyone in that
  channel sees it: Slack guests, and in a shared channel people from other
  organizations, included.
- **What still needs a person**: writing. Pushing a branch and opening a pull request
  waits for an Approve in the thread; only then is a write token asked for.

To limit it:

- Install the App on fewer repositories: only those whose contents everyone in every
  channel in `AGENT_CHANNELS` may read. Remove one from the same page as in
  step 4.
- Keep the agent out of channels with guests (or anyone who shouldn't read those
  repositories): don't list them in `AGENT_CHANNELS`. Removing a channel stops it there,
  threads included, and emptying the list stops it everywhere; the next start also
  purges what was indexed from it. The code tools are on in every listed channel or in none; there is
  no per-channel switch.

Until profiles exist, the install's repository selection is the only limit on which
private repositories can be read. A per-profile repository allowlist (the `credentials`
field in [ADR 0002](adr/0002-profiles.md)) can narrow it later.

With [`GITHUB_TOKEN`](#github_token) (development only), every repository that token can
read is readable this way. The same token can write and enters the sandbox to clone with,
so there the Approve is not a guarantee.

## Rotating the key

Generate a second key on the App's page, set it as `GITHUB_APP_PRIVATE_KEY`, deploy, then
delete the old key on GitHub. Tokens already handed out expire within the hour.

## `GITHUB_TOKEN`

For local development only, a plain token can stand in for the App. It is used as-is for
every repo, for reads and writes alike, so it should be a fine-grained token limited to
a test repo.
