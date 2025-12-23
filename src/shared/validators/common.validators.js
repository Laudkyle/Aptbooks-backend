const { z } = require("zod");

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

module.exports = { z, uuid, isoDate };
