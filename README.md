# npm-offline-uploader

CLI tool for uploading npm packages into a **Sonatype Nexus Repository Manager (Community Edition)** npm-hosted repository. Designed for air-gapped or offline environments where packages must be mirrored into an internal Nexus instance.

## Input format

The uploader expects a `.tgz` archive placed in the `input/` folder. The archive must contain:

```
<any-name>.tgz
├── metadata.json          ← required manifest
├── package-a-1.0.0.tgz
├── package-b-2.3.1.tgz
└── ...
```

### metadata.json schema

```json
{
  "packages": [
    { "name": "express", "version": "4.18.2", "tarball": "express-4.18.2.tgz" },
    { "name": "@babel/core", "version": "7.0.0", "tarball": "babel-core-7.0.0.tgz" }
  ]
}
```

| Field              | Description                                                                 |
|--------------------|-----------------------------------------------------------------------------|
| `packages[].name`  | npm package name — scoped names (`@scope/pkg`) are supported                |
| `packages[].version` | semver version string                                                     |
| `packages[].tarball` | filename of the corresponding `.tgz` at the root of the archive. For scoped packages, the `@` and `/` are flattened: `@babel/core` → `babel-core-7.0.0.tgz` |

Every `tarball` filename referenced in `packages` must be present in the archive.

## How it works

For each package in `metadata.json`, the uploader:

1. **Skips** packages already present in Nexus — prevents SHA checksum corruption that can break `package-lock.json` for offline consumers
2. **Strips `publishConfig`** from the embedded `package.json` before uploading — removes external registry references that would otherwise be stored in Nexus metadata and misdirect npm clients
3. **Uploads** the tarball to Nexus via the REST API using `multipart/form-data`
4. **Tags as `latest`** if the version is the highest *stable* semver for that package name within the archive — pre-release versions (e.g. `1.0.0-beta`) are never tagged as `latest`. The tag is also skipped if a higher version already exists in Nexus, even if it was loaded without a `latest` tag. A tagging failure emits a `! warning` line but does not count the package as failed

## Prerequisites

- Node.js ≥ 18
- A running Sonatype Nexus Repository Manager instance with an npm-hosted repository
- A Nexus user account with deploy privileges on that repository

## Setup

```bash
git clone <repo-url>
cd npm-offline-uploader
npm install
cp .env.template .env
```

Edit `.env` with your Nexus connection details:

```env
NEXUS_URL=https://nexus.internal:8081
NEXUS_REPOSITORY=npm-hosted
NEXUS_USERNAME=deployer
NEXUS_PASSWORD=yourpassword
```

## Usage

Drop your `.tgz` archive into the `input/` folder, then run:

```bash
npm run dev
```

Select the archive from the list:

```
? Select a tgz archive to upload: (Use arrow keys)
❯ my-packages-2026-03-28.tgz

Uploading packages to Nexus...

  ~ lodash@4.17.20 — already exists, skipping
  ✂ react@18.2.0 — publishConfig stripped
  ✓ react@18.2.0
    → tagged as latest
  ✓ react-dom@18.2.0

Done. Succeeded: 2  Skipped: 1  Failed: 0
```

## Environment variables

| Variable           | Description                                                          |
|--------------------|----------------------------------------------------------------------|
| `NEXUS_URL`        | Base URL of your Nexus instance, no trailing slash. Prefer `https://` — `http://` is allowed but triggers a warning |
| `NEXUS_REPOSITORY` | Name of the npm-hosted repository                                    |
| `NEXUS_USERNAME`   | Nexus username with deploy privileges                                |
| `NEXUS_PASSWORD`   | Password for the above user                                          |

## Scripts

| Command          | Description                        |
|------------------|------------------------------------|
| `npm run dev`    | Run with auto-reload (tsx watch)   |
| `npm run start`  | Run once                           |
| `npm run build`  | Compile TypeScript to `dist/`      |
| `npm run format` | Format source files with Prettier  |
