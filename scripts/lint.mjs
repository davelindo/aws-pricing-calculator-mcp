import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const SCAN_DIRS = ["bin", "src", "test", "scripts"];

async function listJsFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await listJsFiles(fullPath)));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".js") && !entry.name.endsWith(".test.js.snap")) {
      files.push(fullPath);
    }
  }

  return files;
}

const files = (
  await Promise.all(
    SCAN_DIRS.map(async (scanDir) => {
      try {
        return await listJsFiles(join(ROOT, scanDir));
      } catch {
        return [];
      }
    }),
  )
).flat();

let failed = false;

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], {
    cwd: ROOT,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    failed = true;
  }
}

if (failed) {
  process.exit(1);
}

console.log(`Checked ${files.length} JavaScript files.`);
