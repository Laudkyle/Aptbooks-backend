const fs = require("fs"); 
const path = require("path"); 
const { AppError } = require("../../shared/errors/AppError"); 

const LOCALES_DIR = path.join(__dirname, "locales"); 
const DEFAULT_LOCALE = "en"; 

function listLocales() {
  const locales = fs.readdirSync(LOCALES_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort(); 
  return { data: { locales, default_locale: DEFAULT_LOCALE } }; 
}

function getMessages(locale) {
  const safe = String(locale || "").toLowerCase().replace(/[^a-z0-9_-]/g, ""); 
  const file = path.join(LOCALES_DIR, `${safe}.json`); 
  if (!fs.existsSync(file)) throw new AppError(404, "Locale not found"); 
  const json = JSON.parse(fs.readFileSync(file, "utf8")); 
  return { data: { locale: safe, messages: json } }; 
}

module.exports = { listLocales, getMessages }; 
