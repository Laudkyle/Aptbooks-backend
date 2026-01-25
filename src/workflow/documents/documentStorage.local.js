const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { pipeline } = require("stream/promises");

async function ensureDir(dirPath) {
  await fs.promises.mkdir(dirPath, { recursive: true });
}

/**
 * Writes a buffer to permanent storage, computing sha256.
 *
 * @returns {Promise<{relpath: string, checksum_sha256: string, size_bytes: number}>}
 */
async function storeBuffer({ rootDir, relpath, buffer }) {
  const absPath = path.join(rootDir, relpath);
  const dir = path.dirname(absPath);
  await ensureDir(dir);

  const tmpPath = absPath + ".tmp-" + crypto.randomBytes(6).toString("hex");
  const hash = crypto.createHash("sha256");
  hash.update(buffer);
  const checksum = hash.digest("hex");

  await fs.promises.writeFile(tmpPath, buffer);
  await fs.promises.rename(tmpPath, absPath);
  return { relpath, checksum_sha256: checksum, size_bytes: buffer.length };
}

/**
 * Streams a file from tempPath into permanent storage, computing sha256.
 *
 * @returns {Promise<{relpath: string, checksum_sha256: string, size_bytes: number}>}
 */
async function storeFromFile({ rootDir, relpath, tempPath }) {
  const absPath = path.join(rootDir, relpath);
  const dir = path.dirname(absPath);
  await ensureDir(dir);

  const tmpPath = absPath + ".tmp-" + crypto.randomBytes(6).toString("hex");
  const hash = crypto.createHash("sha256");
  let size = 0;

  const rs = fs.createReadStream(tempPath);
  rs.on("data", (chunk) => {
    size += chunk.length;
    hash.update(chunk);
  });
  const ws = fs.createWriteStream(tmpPath, { flags: "wx" });
  await pipeline(rs, ws);
  await fs.promises.rename(tmpPath, absPath);
  return { relpath, checksum_sha256: hash.digest("hex"), size_bytes: size };
}

function createReadStream({ rootDir, relpath }) {
  const absPath = path.join(rootDir, relpath);
  return fs.createReadStream(absPath);
}

module.exports = { storeBuffer, storeFromFile, createReadStream };
