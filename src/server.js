const http = require("http");
const app = require("./app");
const { env } = require("./config/env");
const logger = require("./config/logger");

http.createServer(app).listen(env.PORT, () => {
  logger.info({ port: env.PORT }, "Server listening");
});
