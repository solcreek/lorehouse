# GitHub access: a GitHub App

The code tools reach GitHub as a GitHub App, not as a person. The App belongs to the
organization, pull requests are opened by the App's bot, and Lorehouse never
holds a long-lived token:

- For every repo it needs, Lorehouse signs a JWT with the App's private key and trades it
  for an installation token that lasts an hour and covers **that one repo**.
- Cloning asks for `contents: read`. Pushing a branch and opening a pull request asks for
  `contents: write` and `pull_requests: write`, and only after someone approves the pull
  request in Slack.
- The token reaches the sandbox only in the environment of the one git command that needs
  it, through a credential helper. It is never in the command line or the remote URL.
  That command runs with hooks off and every other credential helper dropped, and the
  helper answers only for `https://github.com`, so nothing the checkout configures (a
  hook, a helper, an `insteadOf` redirect) can capture it. A push goes to the repo's
  github.com URL, never to whatever `origin` points at.
- What that can't stop: code run earlier in the sandbox replacing `git` itself. The
  sandbox is the model's, so a token handed into it is protected by its scope (one repo,
  the least permission, an hour) and by the approval before any write token exists.
- Commits are by the App's bot too, `<app>[bot]` at its noreply address, so GitHub links
  each commit to the bot. Every command the agent runs has git's author and committer
  set to it (they outrank any git config), and a pull request whose commits are by
  anyone else is sent back to be re-authored before anyone is asked to approve it.
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
   agent may work on. Add more later from the same page.
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

## Rotating the key

Generate a second key on the App's page, set it as `GITHUB_APP_PRIVATE_KEY`, deploy, then
delete the old key on GitHub. Tokens already handed out expire within the hour.

## `GITHUB_TOKEN`

For local development only, a plain token can stand in for the App. It is used as-is for
every repo, for reads and writes alike, so it should be a fine-grained token limited to
a test repo.
