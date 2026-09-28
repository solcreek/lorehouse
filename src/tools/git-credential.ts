// git-credential.ts — one git command in the sandbox, with a GitHub token.
//
// The token is in that command's env only: never in argv, never in .git/config. And the
// command runs so that nothing the checkout configures can capture it:
//   - hooks are off (core.hooksPath=/dev/null): a pre-push hook planted in the checkout
//     would otherwise run with the token in its env;
//   - every other credential helper is dropped (an empty credential.helper resets the
//     list): after a success git hands the credential to each helper to `store`;
//   - the helper answers only for https://github.com, so a url.*.insteadOf or pushurl in
//     the checkout's config can redirect the command, never the token;
//   - with no answer, git fails instead of prompting (GIT_TERMINAL_PROMPT=0).
//
// What this can't stop: code run earlier in the sandbox that replaced git itself. The
// sandbox is the model's; a token handed into it is only as safe as the binary it runs.
// Hence the narrow tokens (one repo, the least permission, an hour) and the approval gate.

const TOKEN_ENV = "LOREHOUSE_GH_TOKEN";

// Git runs a `!` helper as a shell command with the action (get, store, erase) appended,
// and the request (protocol=…, host=…) on stdin. No single quotes: it's quoted below.
export const HELPER =
  `!f() { test "$1" = get || exit 0; p=; h=; while IFS== read -r k v; do case $k in protocol) p=$v;; host) h=$v;; esac; done; ` +
  `if test "$p" = https && test "$h" = github.com; then echo username=x-access-token; echo "password=$${TOKEN_ENV}"; fi; }; f`;

// `git <args>`, run with the token (pass tokenEnv(token) as the command's env).
export function gitWithToken(args: string): string {
  return `git -c core.hooksPath=/dev/null -c credential.helper= -c credential.helper='${HELPER}' ${args}`;
}

export function tokenEnv(token: string): Record<string, string> {
  return { [TOKEN_ENV]: token, GIT_TERMINAL_PROMPT: "0" };
}
