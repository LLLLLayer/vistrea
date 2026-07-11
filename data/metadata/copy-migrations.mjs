import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const filenamePattern = /^([0-9]{6})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;
const sourceDirectory = path.resolve("data/metadata/migrations");
const outputArgument = process.argv[2];

if (outputArgument === undefined) {
  throw new Error("Usage: node data/metadata/copy-migrations.mjs <output-directory>");
}

const outputDirectory = path.resolve(outputArgument);
const entries = await fs.readdir(sourceDirectory);
const unexpectedSql = entries.filter(
  (entry) => entry.endsWith(".sql") && !filenamePattern.test(entry),
);
if (unexpectedSql.length > 0) {
  throw new Error(`Invalid SQLite migration filenames: ${unexpectedSql.sort().join(", ")}`);
}

const filenames = entries.filter((entry) => filenamePattern.test(entry)).sort();
if (filenames.length === 0) {
  throw new Error("At least one SQLite migration is required.");
}
for (const [index, filename] of filenames.entries()) {
  const version = Number(filenamePattern.exec(filename)?.[1]);
  if (version !== index + 1) {
    throw new Error(
      `SQLite migration versions must be gap-free; ${filename} is not version ${index + 1}.`,
    );
  }
}

await fs.rm(outputDirectory, { recursive: true, force: true });
await fs.mkdir(outputDirectory, { recursive: true });
const migrations = [];
for (const filename of filenames) {
  const sourcePath = path.join(sourceDirectory, filename);
  const outputPath = path.join(outputDirectory, filename);
  const sourceBytes = await fs.readFile(sourcePath);
  await fs.writeFile(outputPath, sourceBytes, { flag: "wx" });
  const outputBytes = await fs.readFile(outputPath);
  if (!sourceBytes.equals(outputBytes)) {
    throw new Error(`Packaged SQLite migration bytes changed for ${filename}.`);
  }
  migrations.push({
    filename,
    sha256: createHash("sha256").update(sourceBytes).digest("hex"),
  });
}

const manifest = `${JSON.stringify({ version: 1, migrations }, null, 2)}\n`;
await fs.writeFile(path.join(outputDirectory, "manifest.json"), manifest, {
  encoding: "utf8",
  flag: "wx",
});
