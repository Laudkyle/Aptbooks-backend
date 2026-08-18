const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { AppError } = require("../../shared/errors/AppError");

const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

function assertEnabled() {
  if ((process.env.NODE_ENV || "development").toLowerCase() === "production") {
    throw new AppError(403, "Test runner API is not available in production.");
  }
  if ((process.env.ALLOW_TEST_RUN_API || "").toLowerCase() !== "true") {
    throw new AppError(403, "Test runner API is disabled. Set ALLOW_TEST_RUN_API=true to enable in a non-production environment.");
  }
}

function listTestFiles() {
  assertEnabled();
  const testsDir = path.resolve(__dirname, "../../tests");
  if (!fs.existsSync(testsDir)) return [];
  return fs
    .readdirSync(testsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.js"))
    .map((entry) => entry.name)
    .sort();
}

function validatePattern(pattern) {
  if (pattern == null || pattern === "") return null;
  const value = String(pattern);
  if (value.length > 500) throw new AppError(400, "Test name pattern is too long");
  if (value.includes("\0")) throw new AppError(400, "Invalid test name pattern");
  return value;
}

function runTest({ testFile, pattern }) {
  assertEnabled();

  if (testFile && !listTestFiles().includes(String(testFile))) {
    throw new AppError(400, "testFile must be one of the files returned by /utilities/tests/list");
  }

  const safePattern = validatePattern(pattern);
  const args = ["jest"];
  if (testFile) args.push(String(testFile));
  if (safePattern) args.push("-t", safePattern);
  args.push("--runInBand");

  const executable = process.platform === "win32" ? "npx.cmd" : "npx";
  const commandForDisplay = [executable, ...args];

  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd: path.resolve(__dirname, "../../.."),
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timeoutMs = Math.max(1000, Math.min(300000, Number(process.env.TEST_RUNNER_TIMEOUT_MS || 120000)));
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let killedForLimit = false;
    let settled = false;

    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);

    function capture(target, chunk) {
      const text = chunk.toString();
      outputBytes += Buffer.byteLength(text);
      if (outputBytes > MAX_OUTPUT_BYTES) {
        killedForLimit = true;
        child.kill("SIGKILL");
        return target;
      }
      return target + text;
    }

    child.stdout.on("data", (chunk) => { stdout = capture(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = capture(stderr, chunk); });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        command: commandForDisplay,
        ok: false,
        exitCode: null,
        stdout,
        stderr: `${stderr}${error.message || error}`,
      });
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killedForLimit) stderr += "\nTest output exceeded the 10 MiB limit.";
      else if (signal) stderr += `\nTest process terminated by ${signal}.`;
      resolve({
        command: commandForDisplay,
        ok: code === 0 && !killedForLimit,
        exitCode: typeof code === "number" ? code : null,
        stdout,
        stderr,
      });
    });
  });
}

module.exports = { listTestFiles, runTest, assertEnabled };
