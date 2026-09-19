// Conventional Commits gate. Enforced locally by the commit-msg hook
// (.githooks, installed on `npm install`) and on PRs by CI.
//
// The changelog is hand-written, not derived from commits, so the type is
// documentation, not automation — but a consistent history is what makes
// `git log --oneline` scannable and RELEASING.md's bump rules auditable.
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // Bodies carry release-note prose and long URLs.
    'body-max-line-length': [0, 'always'],
    'footer-max-line-length': [0, 'always'],
  },
}
