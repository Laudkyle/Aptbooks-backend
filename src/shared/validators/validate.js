const { AppError } = require("../errors/AppError");

function validate(schema, data) {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw new AppError(400, "Validation error", r.error.flatten());
  }
  return r.data;
}

module.exports = { validate };
