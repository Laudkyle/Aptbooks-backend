require("dotenv").config();

function must(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

const env = {
  PORT: process.env.PORT || 3000,
  DATABASE_URL: must("DATABASE_URL"),
  JWT_SECRET: must("JWT_SECRET"),
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || "12h",
  BCRYPT_ROUNDS: parseInt(process.env.BCRYPT_ROUNDS || "12", 10)
};

module.exports = { env };
