# Creator Verification

Creators apply for the verified badge by linking their public accounts and placing a proof code on each one. A reviewer checks the links, then approves or rejects the application (#1324).

## Creator routes (`/v1/creators/me/verification`)

Requires a wallet JWT for a wallet linked to a user who owns a creator profile.

| Method | Path                                | Purpose                                                              |
| ------ | ----------------------------------- | -------------------------------------------------------------------- |
| `POST` | `/creators/me/verification`         | Apply. `201` with the application and its `proofCode`.               |
| `GET`  | `/creators/me/verification`         | Your most recent application, or `null`.                             |

### Applying

```json
{
   "legalName": "Ada Lovelace",
   "links": [
      { "provider": "github", "url": "https://github.com/ada" },
      { "provider": "website", "url": "https://ada.example.com/about" }
   ]
}
```

- `provider` is one of `twitter`, `github` or `website`. Between 1 and 5 links are allowed.
- Links must be public HTTPS pages. Twitter links must be on `x.com` or `twitter.com`, and GitHub links on `github.com`.
- Each application gets its own `proofCode` (for example `AL-VERIFY-3F9A2C71B0D4`). Put it in the bio or on the page for every linked account.
- The legal name is not stored. Only a keyed hash of it is kept, so reviewers can spot the same name on several applications.
- A creator can have one open application at a time. A rejected creator can apply again. Earlier applications and their decisions are kept.

## Reviewer routes (`/v1/admin/verification`)

Requires the admin JWT.

| Method | Path                                             | Purpose                                                         |
| ------ | ------------------------------------------------ | --------------------------------------------------------------- |
| `GET`  | `/applications?status=&page=&limit=`             | Review queue, oldest first.                                     |
| `GET`  | `/applications/:id`                              | Application with its proofs and full decision history.           |
| `POST` | `/applications/:id/claim`                        | Claim for review. `submitted` moves to `in_review`.              |
| `POST` | `/applications/:id/proof-check`                  | Fetch every linked page and look for the proof code.             |
| `POST` | `/applications/:id/decision`                     | `{ "decision": "approved" \| "rejected", "note": "..." }`        |

### Workflow

```
submitted ──claim──► in_review ──approve──► approved   (creator verified)
                          └────reject────► rejected   (creator may reapply)
```

- Only the reviewer who claimed an application can decide it.
- **Approval requires a passing proof check**, meaning the proof code was found on every linked account. Run `proof-check` first. A link that fails leaves its proof `failed`, with a `failureReason`.
- Every claim and decision is written to the application's decision history with the reviewer and note.

## Verified flag

Approval sets `isVerified: true` and `verifiedAt` on the creator profile, in the same transaction as the decision.

The following responses now include `verified` (same value as `isVerified`) and `verifiedAt` (ISO time, or `null`):

- `GET` of a creator's public profile (`CreatorPublicProfileResult`). `verifiedAt` is the earliest approval among the creator's verified profiles.
- Deployed-key items in the creator's key list (`CreatorDeployedKeyItem`), using each key's own creator profile.

These responses are cached for up to 5 minutes, so the badge can take that long to appear after approval.

## Proof checks and their limits

The check fetches each linked page over HTTPS with a 10-second timeout, reads up to 1 MB, and looks for the proof code as a substring. Redirects are followed, and the final URL is checked again.

Links are refused before any request when they are not public HTTPS URLs. That covers IP literals, `localhost`, internal names such as `*.internal`, and URLs with credentials or non-443 ports. This does not defend against DNS rebinding, so the outbound network should also block private address ranges.

Some sites only render the bio with JavaScript. A check on such a page can fail even when the code is present. A reviewer can run the check again or reject the application with a note.
