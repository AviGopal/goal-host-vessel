import { readdir, readFile } from "fs/promises";
import { join } from "path";

const SRC_DIR = join(import.meta.dirname, "..", "src");

async function countLines(filePath: string): Promise<number> {
  try {
    const content = await readFile(filePath, "utf-8");
    const lines = content.split("\n");
    return lines.length;
  } catch {
    return 0;
  }
}

async function main() {
  try {
    const entries = await readdir(SRC_DIR, { withFileTypes: true });
    const files = entries
      .filter((e) => e.isFile() && e.name.endsWith(".ts"))
      .map((e) => join(SRC_DIR, e.name));

    const counts = await Promise.all(files.map(countLines));
    const total = counts.reduce((sum, n) => sum + n, 0);

    console.log(total);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

main();
