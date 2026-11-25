# Supply Chain Security

The `Supply chain` workflow ([`.github/workflows/supply-chain.yml`](../../.github/workflows/supply-chain.yml))
and Renovate ([`renovate.json`](../../renovate.json)) keep dependencies and workflow actions
under review. This page is the operator guide.

## What runs and when

| Check | Runs on | Fails when | Script or config |
| --- | --- | --- | --- |
| Action pinning | every PR and push to `main` | a `uses:` line is not pinned to a 40-character commit SHA | [`scripts/check-action-pins.mjs`](../../scripts/check-action-pins.mjs) |
| Production licenses | every PR and push to `main` | a package license is not on the allowlist, or an exception has expired | [`license-policy.json`](../../license-policy.json), [`scripts/check-licenses.mjs`](../../scripts/check-licenses.mjs) |
| High and critical advisories | every PR and push to `main` | an advisory has no current, dated exception | [`security/audit-exceptions.json`](../../security/audit-exceptions.json), [`scripts/check-audit-exceptions.mjs`](../../scripts/check-audit-exceptions.mjs) |
| SBOM (CycloneDX 1.5, production only) | each published release, and manual dispatch | never fails the build; it uploads `sbom-<tag>` and attaches `sbom.cdx.json` to the release | `@cyclonedx/cyclonedx-npm@7.0.1` |
| Dependency updates | weekly, Monday before 06:00 UTC | not applicable | `renovate.json` |

Tool versions are pinned in the workflow (`license-checker-rseidelsohn@5.0.1`,
`@cyclonedx/cyclonedx-npm@7.0.1`). Bump them deliberately.

## Renovate behaviour

- Minor updates are grouped into one pull request (`minor-dependencies`).
- GitHub Actions updates are grouped (`github-actions`). The `helpers:pinGitHubActionDigests`
  preset keeps them on commit SHAs.
- Patch updates auto-merge through a pull request once the required checks pass.
- Renovate must be installed on the repository for this config to take effect.

## Handling a license failure

1. Read the `::error::` annotation. It names the package and its license.
2. If the license can be replaced by an allowed one (a different version, a different package), do that.
3. If it cannot, add an exception to `license-policy.json` with the package name, the license,
   a reason and an `expires` date no more than six months out. Get a second reviewer to
   approve it in the pull request.

Exceptions expire. When one expires, the check fails again until it is renewed with review or removed.

## Handling a high or critical advisory

1. Run `pnpm audit` locally and read the advisory. Check whether the vulnerable code path is reachable.
2. Upgrade the dependency. Renovate proposes most upgrades; a manual upgrade is fine when it is urgent.
3. If no fixed version exists, or the upgrade breaks the build, add an entry to
   `security/audit-exceptions.json`:

   ```json
   {
      "id": "GHSA-xxxx-xxxx-xxxx",
      "package": "some-package",
      "reason": "Not reachable: the affected parser only receives trusted input from …",
      "approvedBy": "maintainer-handle",
      "expires": "2027-03-31"
   }
   ```

   `id` must match the advisory's GHSA id or a CVE id. Exceptions cannot be open-ended, so each
   one needs an expiry date.
4. Put a link to the advisory in the pull request and say when the exception will be removed.

`audit-ci` is not used: it has no expiry support, and dated exceptions are the point of this process.

## Adding a workflow or a new action

Pin every action to a full commit SHA with a version comment:

```yaml
- uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
```

Look up the SHA with `gh api repos/<owner>/<repo>/commits/<tag> --jq .sha`. Renovate keeps the SHA current.
Run `node scripts/check-action-pins.mjs` to check locally.

## Known gaps

- The first run may flag packages whose licenses are not on the allowlist. For example, the
  prebuilt `@img/sharp-libvips-*` binaries used by `sharp` are LGPL. Each needs a reviewed exception.
- If `pnpm audit` already reports high or critical advisories on `main`, the advisory gate will
  fail on existing pull requests until the advisories are fixed or excepted.
