import fs from "fs";
import path from "path";
import inquirer from "inquirer";
import { upload } from "./upload.js";

function listZipFiles(inputDir: string): string[] {
  try {
    return fs
      .readdirSync(inputDir)
      .filter((name) => name.toLowerCase().endsWith(".zip") && fs.statSync(path.join(inputDir, name)).isFile())
      .sort()
      .map((name) => path.join(inputDir, name));
  } catch {
    return [];
  }
}

async function main() {
  const inputDir = path.resolve(process.cwd(), "input");
  const zipFiles = listZipFiles(inputDir);

  if (zipFiles.length === 0) {
    console.log("No .zip files found in input/. Drop a package archive there and try again.");
    process.exit(0);
  }

  const { zipPath } = await inquirer.prompt([
    {
      type: "list",
      name: "zipPath",
      message: "Select a zip archive to upload:",
      choices: zipFiles.map((f) => ({ name: path.basename(f), value: f })),
    },
  ]);

  console.log("\nUploading packages to Nexus...\n");

  try {
    const result = await upload(zipPath);

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
