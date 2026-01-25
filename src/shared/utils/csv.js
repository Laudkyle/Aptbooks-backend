const { AppError } = require("../errors/AppError"); 

function splitCsvLine(line) {
  // Minimal RFC4180-ish parser supporting quotes and commas.
  const out = []; 
  let cur = ""; 
  let inQ = false; 

  for (let i = 0;  i < line.length;  i += 1) {
    const c = line[i]; 

    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"'; 
          i += 1; 
        } else {
          inQ = false; 
        }
      } else {
        cur += c; 
      }
      continue; 
    }

    if (c === ',') {
      out.push(cur); 
      cur = ""; 
      continue; 
    }

    if (c === '"') {
      inQ = true; 
      continue; 
    }

    cur += c; 
  }

  out.push(cur); 
  return out; 
}

function parseCsvText(text) {
  if (typeof text !== "string" || !text.trim()) {
    throw new AppError(400, "CSV body is required"); 
  }

  const lines = text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .filter((l) => l.trim().length > 0); 

  if (lines.length < 2) {
    throw new AppError(400, "CSV must include header and at least one row"); 
  }

  const header = splitCsvLine(lines[0]).map((h) => h.trim()); 
  const rows = []; 

  for (let i = 1;  i < lines.length;  i += 1) {
    const cols = splitCsvLine(lines[i]); 
    const obj = {}; 
    for (let j = 0;  j < header.length;  j += 1) {
      obj[header[j]] = (cols[j] ?? "").trim(); 
    }
    rows.push(obj); 
  }

  return rows; 
}

module.exports = { splitCsvLine, parseCsvText }; 
