import AdmZip from "adm-zip";
import axios from "axios";
import fs from "fs";
import os from "os";
import path from "path";
import semver from "semver";
import { x as tarExtract, c as tarCreate } from "tar";

interface PackageEntry {
  name: string;
  version: string;
  tarball: string;
}

interface Metadata {
  packages: PackageEntry[];
}

interface UploadError {
  name: string;
  version: string;
  message: string;
}

export interface UploadResult {
  succeeded: number;
  skipped: number;
  failed: number;
  errors: UploadError[];
}

// Strips publishConfig from package/package.json inside a .tgz, repacking it in-place.
// Returns true if publishConfig was found and removed, false if no change was needed.
async function stripPublishConfig(tgzPath: string, tmpDir: string): Promise<boolean> {
  const extractDir = fs.mkdtempSync(path.join(tmpDir, "strip-"));

  try {
    await tarExtract({ file: tgzPath, cwd: extractDir });

    const pkgJsonPath = path.join(extractDir, "package", "package.json");

    let pkgJson: Record<string, unknown>;
    try {
      pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
    } catch {
      return false;
    }

    if (!pkgJson.publishConfig) {
      return false;
    }

    delete pkgJson.publishConfig;
    fs.writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2));

    await tarCreate({ gzip: true, file: tgzPath, cwd: extractDir }, ["package"]);
    return true;
  } finally {
    fs.rmSync(extractDir, { recursive: true, force: true });
  }
}

// Encodes a package name for use in npm registry URL paths.
// Scoped packages: @babel/core → @babel%2Fcore
function encodePackageName(name: string): string {
  if (name.startsWith("@")) {
    const slash = name.indexOf("/");
    if (slash === -1) return encodeURIComponent(name);
    return `${name.slice(0, slash)}%2F${name.slice(slash + 1)}`;
  }
  return name;
}

// Builds a map of package name → highest semver version from the metadata.
function buildLatestVersionMap(packages: PackageEntry[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const pkg of packages) {
    const current = map.get(pkg.name);
    if (!current || semver.gt(pkg.version, current)) {
      map.set(pkg.name, pkg.version);
    }
  }
  return map;
}

async function tagAsLatest(nexusUrl: string, repository: string, auth: string, name: string, version: string): Promise<void> {
  const url = `${nexusUrl}/repository/${repository}/${encodePackageName(name)}/-/dist-tags/latest`;
  await axios.put(url, JSON.stringify(version), {
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
    },
  });
}

async function packageExists(nexusUrl: string, repository: string, auth: string, name: string, version: string): Promise<boolean> {
  // Use the npm registry protocol endpoint rather than the REST search API.
  // The search index is updated asynchronously and can return stale results,
  // causing false negatives that allow existing packages to be re-uploaded.
  const url = `${nexusUrl}/repository/${repository}/${encodePackageName(name)}/${version}`;
  try {
    await axios.get(url, { headers: { Authorization: `Basic ${auth}` } });
    return true;
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 404) {
      return false;
    }
    // Non-404 errors (network failure, 5xx, auth) propagate — don't silently re-upload.
    throw err;
  }
}

async function getNexusLatestVersion(nexusUrl: string, repository: string, auth: string, name: string): Promise<string | null> {
  // Fetch the package document from the npm registry endpoint to read the current
  // dist-tags.latest. Returns null if the package doesn't exist yet in Nexus.
  const url = `${nexusUrl}/repository/${repository}/${encodePackageName(name)}`;
  try {
    const response = await axios.get<{ "dist-tags"?: { latest?: string } }>(url, {
      headers: { Authorization: `Basic ${auth}` },
    });
    return response.data["dist-tags"]?.latest ?? null;
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 404) {
      return null;
    }
    throw err;
  }
}

function resolveEnv(): { nexusUrl: string; repository: string; username: string; password: string } {
  const nexusUrl = process.env.NEXUS_URL;
  const repository = process.env.NEXUS_REPOSITORY;
  const username = process.env.NEXUS_USERNAME;
  const password = process.env.NEXUS_PASSWORD;

  const missing = (["NEXUS_URL", "NEXUS_REPOSITORY", "NEXUS_USERNAME", "NEXUS_PASSWORD"] as const).filter(
    (key) => !process.env[key],
  );

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }

  if (nexusUrl!.startsWith("http://")) {
    console.warn("Warning: NEXUS_URL uses HTTP — credentials and package data will be transmitted unencrypted. Use HTTPS in production.");
  }

  return { nexusUrl: nexusUrl!, repository: repository!, username: username!, password: password! };
}

export async function upload(zipPath: string): Promise<UploadResult> {
  const { nexusUrl, repository, username, password } = resolveEnv();
  const auth = Buffer.from(`${username}:${password}`).toString("base64");
  const endpoint = `${nexusUrl}/service/rest/v1/components?repository=${repository}`;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "npm-upload-"));

  try {
    const zip = new AdmZip(zipPath);
    const resolvedTmpDir = path.resolve(tmpDir);
    for (const entry of zip.getEntries()) {
      const resolvedEntry = path.resolve(tmpDir, entry.entryName);
      if (!resolvedEntry.startsWith(resolvedTmpDir + path.sep)) {
        throw new Error(`Zip contains unsafe entry path: ${entry.entryName}`);
      }
    }
    zip.extractAllTo(tmpDir, true);

    const metadataPath = path.join(tmpDir, "metadata.json");
    if (!fs.existsSync(metadataPath)) {
      throw new Error("metadata.json not found in zip — see README.md for the expected archive format.");
    }

    let metadata: Metadata;
    try {
      metadata = JSON.parse(fs.readFileSync(metadataPath, "utf-8"));
    } catch {
      throw new Error("metadata.json is not valid JSON");
    }
    if (!Array.isArray(metadata?.packages)) {
      throw new Error("metadata.json is missing a valid 'packages' array");
    }
    const latestVersionMap = buildLatestVersionMap(metadata.packages);
    const result: UploadResult = { succeeded: 0, skipped: 0, failed: 0, errors: [] };

    for (const pkg of metadata.packages) {
      const exists = await packageExists(nexusUrl, repository, auth, pkg.name, pkg.version);
      if (exists) {
        console.log(`  ~ ${pkg.name}@${pkg.version} — already exists, skipping`);
        result.skipped++;
        continue;
      }

      const tgzPath = path.join(tmpDir, pkg.tarball);

      if (!path.resolve(tgzPath).startsWith(path.resolve(tmpDir) + path.sep)) {
        console.error(`  ✗ ${pkg.name}@${pkg.version} — unsafe tarball path: ${pkg.tarball}`);
        result.failed++;
        result.errors.push({ name: pkg.name, version: pkg.version, message: `Unsafe tarball path: ${pkg.tarball}` });
        continue;
      }

      if (!fs.existsSync(tgzPath)) {
        console.error(`  ✗ ${pkg.name}@${pkg.version} — tarball not found: ${pkg.tarball}`);
        result.failed++;
        result.errors.push({ name: pkg.name, version: pkg.version, message: `Tarball not found: ${pkg.tarball}` });
        continue;
      }

      const stripped = await stripPublishConfig(tgzPath, tmpDir);
      if (stripped) {
        console.log(`  ✂ ${pkg.name}@${pkg.version} — publishConfig stripped`);
      }

      const tgzBuffer = fs.readFileSync(tgzPath);
      const form = new FormData();
      form.append("npm.asset", new Blob([tgzBuffer], { type: "application/octet-stream" }), pkg.tarball);

      try {
        await axios.post(endpoint, form, {
          headers: { Authorization: `Basic ${auth}` },
        });
        console.log(`  ✓ ${pkg.name}@${pkg.version}`);
        result.succeeded++;
      } catch (err) {
        // Use || instead of ?? so an empty-string response body (Nexus sometimes returns "")
        // falls through to err.message rather than producing a blank error line.
        const message = axios.isAxiosError(err) ? (err.response?.data || err.message) : String(err);
        console.error(`  ✗ ${pkg.name}@${pkg.version} — ${message}`);
        result.failed++;
        result.errors.push({ name: pkg.name, version: pkg.version, message: String(message) });
        // Skip tagging — the upload itself failed, so there is nothing to tag.
        continue;
      }

      // Tagging is intentionally outside the upload try/catch. A tagging failure must not
      // retroactively mark a successful upload as failed or double-count the package.
      if (latestVersionMap.get(pkg.name) === pkg.version) {
        try {
          // Compare against Nexus's current latest before tagging — the zip may not
          // include all versions, so a higher version could already be tagged in Nexus.
          const nexusLatest = await getNexusLatestVersion(nexusUrl, repository, auth, pkg.name);
          if (nexusLatest === null || semver.gt(pkg.version, nexusLatest)) {
            await tagAsLatest(nexusUrl, repository, auth, pkg.name, pkg.version);
            console.log(`    → tagged as latest`);
          }
        } catch (err) {
          const message = axios.isAxiosError(err) ? (err.response?.data || err.message) : String(err);
          console.warn(`    ! failed to tag ${pkg.name} as latest — ${message}`);
        }
      }
    }

    return result;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
