# Contract Error Catalog

Maps numeric Soroban contract error codes to a message and a suggested action, so clients do not hard-code the mapping (#1326).

The catalog is generated from the `#[contracterror]` enums in [accesslayer-contracts](https://github.com/accesslayerorg/accesslayer-contracts) and committed at the repository root as `error-catalog.json`.

## Endpoints

Both routes are mounted under `/api/v1/errors`.

### `GET /errors/catalog?contract=<crate>&version=<id>`

Returns every error for one contract version. Omit `version` for the latest.

`version` accepts a catalog version id (`src-<digest>`) or a wasm hash. Responses include an `ETag`; send it back in `If-None-Match` to receive `304 Not Modified` while the catalog is unchanged.

```json
{
   "success": true,
   "data": {
      "contract": "creator-keys",
      "version": "src-d0264b53850fc1f2",
      "wasmHash": null,
      "sourceCommit": "9a833d7f7a659e1c98e35ed88ba0639222778efc",
      "errorCount": 144,
      "errors": [
         {
            "code": 1,
            "enum": "FeatureError",
            "name": "Unauthorized",
            "message": "The `caller` is not the `creator` owning the key.",
            "suggestedAction": "Sign the request with an account that holds the required authorization, then retry."
         }
      ]
   }
}
```

`message` is `null` for errors the contract source does not document yet.

### `POST /errors/decode`

Matches a failure to a catalog entry. Send either a numeric `code` or a raw simulation/submission failure in `raw`; the code is read from patterns such as `Error(Contract, #7)`.

```json
{ "contract": "creator-keys", "raw": "HostError: Error(Contract, #1)" }
```

Unmatched input (unknown contract, version or code) returns `matched: false` with a generic `fallback` message rather than an error.

## Generating the catalog

```bash
pnpm exec ts-node --transpile-only scripts/build-error-catalog.ts \
   --contracts-dir ../accesslayer-contracts \
   [--wasm-dir <dir-with-built-wasm>] [--source-commit <sha>]
```

- Each contract crate keeps an append-only `versions` list. A version is added only when its error set or wasm hash changes, so older deployments keep decoding their own errors.
- With `--wasm-dir`, a crate's `<crate_name>.wasm` is hashed and used as its version id.
- `--check` (run in CI) fails when the committed file is stale, or when a contract error has no doc comment and is not listed in `scripts/error-catalog-baseline.json`. Documenting an error in the contract with a `///` comment removes it from the baseline.
- Add `/// Action: <text>` to a contract error's doc comment to set its suggested action. Without it, the action is derived from the variant name.

## Caching

The catalog is read from disk and cached in memory. The cache is keyed on the file's modification time, so a regenerated `error-catalog.json` is picked up without a restart. `invalidateErrorCatalogCache()` clears it explicitly.
