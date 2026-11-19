# Security policy
Report vulnerabilities privately via GitHub Security Advisories on this repository. Do not open public issues for security problems.

## Automated checks
- **CodeQL** (`.github/workflows/codeql.yml`) analyses the TypeScript sources with the `security-extended` queries on every push to `main`, on pull requests, and weekly (Mondays 04:23 UTC), so new advisories in unchanged code still surface. Findings appear under the repository's Security tab.
- **Dependency review** (`.github/workflows/dependency-review.yml`) runs on pull requests and fails when a change adds or upgrades to a dependency with a known vulnerability of high severity or worse.
