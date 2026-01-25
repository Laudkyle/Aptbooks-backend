const http = require("http"); 
const app = require("./src/app"); 
const { env } = require("./src/config/env"); 
const logger = require("./src/config/logger"); 

http.createServer(app).listen(env.PORT, () => {
  logger.info({ port: env.PORT }, "Server listening"); 
}); 
const { startScheduler } = require("./src/utilities/scheduled-tasks/scheduler"); 
const { listTasks } = require("./src/utilities/scheduled-tasks/taskRegistry"); 
// after server starts listening:
if (process.env.SCHEDULER_ENABLED !== "false") {
  startScheduler({
    pollIntervalMs: Number(process.env.SCHEDULER_POLL_MS || 5000),
    tasks: listTasks(),
  }).catch((err) => {
    console.log(err)
  }); 
}
