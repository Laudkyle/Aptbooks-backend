const { Pool } = require("pg");
const { env } = require("../config/env");
const { pool } = require("../db/pool");

const pool = new Pool({ connectionString: env.DATABASE_URL });

module.exports = { pool };
