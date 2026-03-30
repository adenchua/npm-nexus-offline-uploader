# CLAUDE.md

## Project overview

CLI tool that uploads npm packages into a **Sonatype Nexus Repository Manager (Community Edition)** npm-hosted repository. Intended for air-gapped or offline environments where packages must be mirrored into an internal Nexus instance.

## Input format

The uploader consumes `.zip` archives dropped into the `input/` folder. Each archive must contain:

```
<any-name>.zip
├── metadata.json
├── express-4.18.2.tgz
├── lodash-4.17.21.tgz
└── ...
```

`metadata.json` schema:
```ts
{
  packages: Array<{ name: string; version: string; tarball: string }>;
}
```

- `packages[].tarball` — filename of the `.tgz` at the root of the zip
- Scoped package tarball naming convention: `@babel/core@7.0.0` → `babel-core-7.0.0.tgz` (`@` removed, `/` replaced with `-`)
- All filenames in `packages` must be present in the zip

## Tech stack

- **Runtime:** Node.js ≥ 18 (native `FormData` is used — do not add the `form-data` package)
- **Language:** TypeScript, compiled with `tsc`, run via `tsx`
- **CLI:** `inquirer` for interactive prompts
- **HTTP:** `axios`
- **ZIP extraction:** `adm-zip` (outer `.zip`)
- **Tarball manipulation:** `tar` (inner `.tgz` files for `publishConfig` stripping)
- **Version comparison:** `semver`
- **Formatter:** Prettier (`printWidth: 120`, `trailingComma: all`, 2-space indent)

## Development commands

```bash
cp .env.template .env   # first-time setup — fill in Nexus credentials
npm install
npm run dev             # run with tsx watch (auto-reloads)
npm run start           # run once
npm run build           # compile to dist/
npm run format          # format src/ with Prettier
```

## Environment variables

Loaded via `tsx --env-file=.env`. See `.env.template` for documented defaults.

| Variable           | Description                                      |
|--------------------|--------------------------------------------------|
| `NEXUS_URL`        | Base URL, no trailing slash (e.g. `https://nexus.internal:8081`) — prefer HTTPS; HTTP triggers a warning |
| `NEXUS_REPOSITORY` | Name of the npm-hosted repository in Nexus       |
| `NEXUS_USERNAME`   | Nexus user with deploy privileges                |
| `NEXUS_PASSWORD`   | Password for the above user                      |

## Architecture

```
src/index.ts    — entry point: scans input/, inquirer list prompt → calls upload()
src/upload.ts   — all upload logic (self-contained)
input/          — drop .zip archives here before running
```

### Entry point (`src/index.ts`)

- `listZipFiles(inputDir)` reads `input/`, filters for `.zip` files (non-symlinks), returns sorted absolute paths
- If no zips found, exits with a message
- Presents a `list` prompt (basename as label, full path as value) — no free-text path input

### Upload flow (`src/upload.ts`)

**Before the loop:**
- All ZIP entry names are resolved against `tmpDir` and verified to stay within it — rejects archives with path traversal entries (e.g. `../../etc/passwd`) before any file is written
- `metadata.json` is parsed inside a try-catch; missing or malformed JSON throws immediately. The parsed object is validated to have a `packages` array before proceeding

**For each package in `metadata.packages`:**

1. **Existence check** — `GET /repository/<repo>/<name>` (full packument), checks `response.versions[version]`.
   Skip if already present. This protects SHA integrity; overwriting an existing package can corrupt the stored checksum and break `package-lock.json` for offline consumers.
   The version-specific manifest endpoint (`GET /<name>/<version>`) is not used — Nexus Community Edition hosted repos return 404 for it unconditionally, regardless of whether the package exists.
   The REST search API (`/service/rest/v1/search`) is also avoided — its index is asynchronous and can return stale results.

2. **Tarball path check** — the resolved path of `pkg.tarball` is verified to remain inside `tmpDir` before the file is read. Malformed `tarball` values in `metadata.json` cannot escape the temp directory.

3. **`publishConfig` stripping** — extracts the `.tgz`, reads `package/package.json` (malformed JSON is silently skipped), deletes the `publishConfig` key if present, repacks. This prevents Nexus from storing an external registry URL in its indexed metadata, which can cause npm clients to resolve packages to the wrong registry.

4. **Upload** — `POST /service/rest/v1/components?repository=<repo>` with `npm.asset` as a `multipart/form-data` field using native `FormData`.

5. **Latest tagging** — if the uploaded version is the highest semver for that package name *within the zip's metadata*, the tool fetches the package's current `dist-tags.latest` from Nexus (`GET /repository/<repo>/<name>`) and only issues `PUT /repository/<repo>/<name>/-/dist-tags/latest` if the new version is strictly greater. This prevents a zip containing an older version from downgrading the `latest` tag when a newer version already exists in Nexus. This runs in its own try/catch, separate from the upload block; a tagging failure prints a `! warning` line but does not mark the package as failed or increment `result.failed`.

### Scoped package encoding in URLs

npm protocol requires `/` in scoped names to be percent-encoded:
`@babel/core` → `@babel%2Fcore` (the `@` is preserved, only `/` is encoded).
Malformed scoped names missing `/` fall back to `encodeURIComponent`.
See `encodePackageName()` in `src/upload.ts`.

## Key decisions

- **No `form-data` package** — Node 18+ ships native `FormData`; axios 1.x supports it directly.
- **`adm-zip` for the outer ZIP** — synchronous, simple API; no streaming needed.
- **`tar` for inner tgz manipulation** — only package used that correctly handles gzipped tar round-trips. `tar` v7 ships its own types and is ESM-only; use named imports (`import { x, c } from "tar"`) — the default import is `undefined` in v7.
- **Latest version is zip-local then Nexus-guarded** — `buildLatestVersionMap` determines the candidate from the zip's metadata (no public registry needed). Before actually tagging, `getNexusLatestVersion` fetches the current `dist-tags.latest` from the local Nexus instance and skips the tag if a higher version is already there. This prevents older zips from downgrading an existing `latest` tag.
- **Temp directory cleanup is always guaranteed** — `stripPublishConfig` and `upload` both use `try/finally` with `fs.rmSync(..., { recursive: true, force: true })`.
- **HTTP triggers a warning, not an error** — internal Nexus instances may not have TLS configured; the tool warns but does not block. Prefer HTTPS in production.
- **ZIP path traversal is rejected pre-extraction** — entry names are resolved and checked against `tmpDir` before `extractAllTo` is called, so no malicious path is ever written to disk.
- **No free-text path input** — the prompt lists only files from `input/`, eliminating user-supplied path risks entirely.
