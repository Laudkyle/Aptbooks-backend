const { AppError } = require("../errors/AppError");

function validate(schema, data) {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw new AppError(422, "Please correct the highlighted fields and try again.", r.error.flatten(), "validation_error");
  }
  return r.data;
}

module.exports = { validate };
