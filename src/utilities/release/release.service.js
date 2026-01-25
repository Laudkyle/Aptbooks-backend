function getReleaseInfo() {
  const env = process.env.NODE_ENV || "development"; 
  return {
    environment: env,
    appVersion: process.env.APP_VERSION || process.env.npm_package_version || null,
    gitSha: process.env.GIT_SHA || process.env.VERCEL_GIT_COMMIT_SHA || null,
    buildTime: process.env.BUILD_TIME || null,
    nodeVersion: process.version,
    uptimeSeconds: Math.floor(process.uptime()),
  }; 
}

module.exports = { getReleaseInfo }; 
