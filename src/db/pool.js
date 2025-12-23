const { Pool } = require("pg");
const { env } = require("../config/env");

const pool = new Pool({ connectionString: env.DATABASE_URL });

module.exports = { pool };
