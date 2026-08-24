const { parseWithSchema } = require("../http/requestValidation");

function validate(schema, data, source = "payload") {
  return parseWithSchema(schema, data, source);
}

module.exports = { validate };
