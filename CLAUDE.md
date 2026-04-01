# CLAUDE.md

## Project overview

CLI tool that uploads npm packages into a **Sonatype Nexus Repository Manager (Community Edition)** npm-hosted repository. Intended for air-gapped or offline environments where packages must be mirrored into an internal Nexus instance.

## Input format

The uploader consumes `.tgz` archives dropped into the `input/` folder. Each archive must contain:

```
<any-name>.tgz
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

- `packages[].tarball` — filename of the `.tgz` at the root of the archive
- Scoped package tarball naming convention: `@babel/core@7.0.0` → `babel-core-7.0.0.tgz` (`@` removed, `/` replaced with `-`)
- All filenames in `packages` must be present in the archive

## Tech stack

- **Runtime:** Node.js ≥ 18 (native `FormData` is used — do not add the `form-data` package)
- **Language:** TypeScript, compiled with `tsc`, run via `tsx`
- **CLI:** `inquirer` for interactive prompts
- **HTTP:** `axios`
- **Archive extraction:** `tar` (outer `.tgz` and inner `.tgz` files for `publishConfig` stripping)
- **Version comparison:** `semver`
- **Formatter:** Prettier (`printWidth: 120`, `trailingComma: all`, 2-space indent)

## Rules

- After modifying any TypeScript file, run `npm run build` to verify the project compiles without errors before considering the task done.

## Development commands

```bash
cp .env.template .env   # first-time setup — fill in Nexus credentials
npm install
npm run dev             # run with tsx watch (auto-reloads)
npm run start           # run once
npm run dev:force       # run with tsx watch, overwriting existing packages
npm run start:force     # run once, overwriting existing packages
npm run build           # compile to dist/
npm run format          # format src/ with Prettier
```

The `:force` variants skip the existence check and overwrite packages already in Nexus. Use them to repair a repository that contains corrupted tarballs from a previous bad upload.

### Docker

```bash
docker compose build                    # build the image
docker compose run --rm uploader        # run once (interactive prompt)
docker compose run --rm uploader-force  # run once, overwriting existing packages
```

Two services are defined in `docker-compose.yml`:
- `uploader` — standard run, reads `.env`, mounts `./input`
- `uploader-force` — same but passes `--force` to skip the existence check

Use `docker compose run` (not `up`) so the interactive `inquirer` prompt attaches to your terminal.

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
input/          — drop .tgz archives here before running
```

### Entry point (`src/index.ts`)

- `listTgzFiles(inputDir)` reads `input/`, filters for `.tgz` files (non-symlinks), returns reverse-sorted absolute paths (Z→A, so the newest/latest-named file appears first in the prompt)
- If no tgz files found, exits with a message
- Presents a `list` prompt (basename as label, full path as value) — no free-text path input

### Upload flow (`src/upload.ts`)

**Before the loop:**
- The archive is extracted with `tarExtract({ file: archivePath, cwd: tmpDir })`. The `tar` package strips unsafe paths by default (`preservePaths: false`), preventing path traversal attacks (e.g. `../../etc/passwd`) without manual entry validation
- `metadata.json` is parsed inside a try-catch; missing or malformed JSON throws immediately. The parsed object is validated to have a `packages` array before proceeding

**For each package in `metadata.packages`:**

1. **Existence check** — `GET /repository/<repo>/<name>` (full packument), checks `response.versions[version]`.
   Skip if already present, unless `--force` / `-f` is passed. Skipping by default protects SHA integrity; overwriting an existing package can corrupt the stored checksum and break `package-lock.json` for offline consumers. Use `--force` only to repair a repository that already contains corrupted data.
   The version-specific manifest endpoint (`GET /<name>/<version>`) is not used — Nexus Community Edition hosted repos return 404 for it unconditionally, regardless of whether the package exists.
   The REST search API (`/service/rest/v1/search`) is also avoided — its index is asynchronous and can return stale results.

2. **Tarball path check** — the resolved path of `pkg.tarball` is verified to remain inside `tmpDir` before the file is read. Malformed `tarball` values in `metadata.json` cannot escape the temp directory.

3. **`publishConfig` stripping** — extracts the `.tgz`, reads `package/package.json` (malformed JSON is silently skipped), deletes the `publishConfig` key if present, repacks. This prevents Nexus from storing an external registry URL in its indexed metadata, which can cause npm clients to resolve packages to the wrong registry.

4. **Upload** — `POST /service/rest/v1/components?repository=<repo>` with `npm.asset` as a `multipart/form-data` field using native `FormData`.

5. **Latest tagging** — if the uploaded version is the highest *stable* (non-prerelease) semver for that package name *within the archive's metadata*, the tool fetches the packument from Nexus (`GET /repository/<repo>/<name>`) and only issues `PUT /repository/<repo>/<name>/-/dist-tags/latest` if the new version is strictly greater than the effective Nexus latest. Pre-release versions (e.g. `1.0.0-beta`) are never tagged as `latest` — npm convention reserves that tag for stable releases. The effective Nexus latest is: `dist-tags.latest` if set and valid, otherwise the highest stable version found in the packument's `versions` map (guards against versions uploaded by other tools without a tag). This runs in its own try/catch, separate from the upload block; a tagging failure prints a `! warning` line but does not mark the package as failed or increment `result.failed`.

### Scoped package encoding in URLs

npm protocol requires `/` in scoped names to be percent-encoded:
`@babel/core` → `@babel%2Fcore` (the `@` is preserved, only `/` is encoded).
Malformed scoped names missing `/` fall back to `encodeURIComponent`.
See `encodePackageName()` in `src/upload.ts`.

## Key decisions

- **No `form-data` package** — Node 18+ ships native `FormData`; axios 1.x supports it directly.
- **`tar` for both outer and inner archives** — handles gzipped tar round-trips for the outer `.tgz` input and for `publishConfig` stripping of inner package tarballs. `tar` v7 ships its own types and is ESM-only; use named imports (`import { x, c } from "tar"`) — the default import is `undefined` in v7. Path traversal protection is provided by tar's default `preservePaths: false` behaviour.
- **Latest version is archive-local then Nexus-guarded** — `buildLatestVersionMap` determines the highest *stable* (non-prerelease) version for each package name in the archive; pre-release versions are skipped entirely because npm convention reserves `latest` for stable releases. Before tagging, `getNexusLatestVersion` determines the effective current latest in Nexus: it uses `dist-tags.latest` if set and valid, then falls back to the highest stable version in the packument's `versions` map. The fallback prevents tagging over a higher version that was loaded into Nexus by another tool without setting the `latest` tag. The tag is only written if the candidate is strictly greater than the effective Nexus latest.
- **Temp directory cleanup is always guaranteed** — `upload` uses `try/finally` with `fs.rmSync(..., { recursive: true, force: true })`.
- **HTTP triggers a warning, not an error** — internal Nexus instances may not have TLS configured; the tool warns but does not block. Prefer HTTPS in production.
- **No free-text path input** — the prompt lists only files from `input/`, eliminating user-supplied path risks entirely.
