import fs from "fs";
import path from "path";
import inquirer from "inquirer";
import { upload } from "./upload.js";

function listTgzFiles(inputDir: string): string[] {
  try {
    return fs
      .readdirSync(inputDir)
      .filter((name) => name.toLowerCase().endsWith(".tgz") && fs.statSync(path.join(inputDir, name)).isFile())
      .sort()
      .reverse()
      .map((name) => path.join(inputDir, name));
  } catch {
    return [];
  }
}

async function main() {
  const inputDir = path.resolve(process.cwd(), "input");
  const tgzFiles = listTgzFiles(inputDir);

  if (tgzFiles.length === 0) {
    console.log("No .tgz files found in input/. Drop a package archive there and try again.");
    process.exit(0);
  }

  const { archivePath } = await inquirer.prompt([
    {
      type: "list",
      name: "archivePath",
      message: "Select a tgz archive to upload:",
      choices: tgzFiles.map((f) => ({ name: path.basename(f), value: f })),
    },
  ]);

  const force = process.argv.includes("--force") || process.argv.includes("-f");

  if (force) {
    console.log("\nWarning: --force is set — existing packages will be overwritten.\n");
  } else {
    console.log("");
  }

  console.log("Uploading packages to Nexus...\n");

  try {
    const result = await upload(archivePath, { force });

    console.log(`\nDone. Succeeded: ${result.succeeded}  Skipped: ${result.skipped}  Failed: ${result.failed}`);

    if (result.errors.length > 0) {
      console.log("\nFailed packages:");
      for (const err of result.errors) {
        console.log(`  ${err.name}@${err.version}: ${err.message}`);
      }
    }
  } catch (err) {
    console.error("\nError:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main();
