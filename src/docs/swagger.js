const path = require("path");
const YAML = require("yamljs");

const specPath = path.join(process.cwd(), "openapi.yaml");
const swaggerDocument = YAML.load(specPath);

module.exports = { swaggerDocument };
