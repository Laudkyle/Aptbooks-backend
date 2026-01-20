const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const { AppError } = require("../../shared/errors/AppError");

function assertEnabled() {
  if ((process.env.ALLOW_TEST_RUN_API || "").toLowerCase() !== "true") {
    throw new AppError(403, "Test runner API is disabled. Set ALLOW_TEST_RUN_API=true to enable.");
  }
}

function listTestFiles() {
  const testsDir = path.resolve(__dirname, "../../tests");
  if (!fs.existsSync(testsDir)) return [];
  return fs
    .readdirSync(testsDir)
    .filter((f) => f.endsWith(".test.js"))
    .sort();
}

function runTest({ testFile, pattern }) {
  assertEnabled();

  const testsDir = path.resolve(__dirname, "../../tests");
  const absFile = testFile ? path.resolve(testsDir, testFile) : null;

  if (testFile) {
    if (!absFile.startsWith(testsDir)) {
      throw new AppError(400, "Invalid testFile path");
    }
    if (!fs.existsSync(absFile)) {
      throw new AppError(404, `Test file not found: ${testFile}`);
    }
  }

  const cmd = process.env.TEST_RUNNER_CMD || "npx jest";
  const args = [];
  if (testFile) args.push(testFile);
  if (pattern) args.push("-t", pattern);
  args.push("--runInBand");

  const fullCmd = `${cmd} ${args.map((a) => JSON.stringify(a)).join(" ")}`;

  return new Promise((resolve) => {
    exec(
      fullCmd,
      {
        cwd: path.resolve(__dirname, "../../.."),
        timeout: Number(process.env.TEST_RUNNER_TIMEOUT_MS || 120000),
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        resolve({
          command: fullCmd,
          ok: !error,
          exitCode: error && typeof error.code === "number" ? error.code : 0,
          stdout: stdout || "",
          stderr: stderr || "",
        });
      }
    );
  });
}

module.exports = { listTestFiles, runTest, assertEnabled };
