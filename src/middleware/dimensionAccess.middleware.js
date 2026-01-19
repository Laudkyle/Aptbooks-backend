const { pool } = require("../db/pool");
const { AppError } = require("../shared/errors/AppError");

function safeParseJson(text) {
  try {
    if (text == null) return null;
    if (typeof text === "object") return text;
    const s = String(text).trim();
    if (!s) return null;
    return JSON.parse(s);
  } catch {
    throw new AppError(400, "Invalid dimensionJson");
  }
}

function matchesRule(ruleJson, dimensionJson) {
  // ruleJson supports:
  //  - equals: { key: value, ... }
  //  - anyOf: [ { equals: {...} }, ... ]
  //  - allOf: [ { equals: {...} }, ... ]
  if (!ruleJson || typeof ruleJson !== "object") return false;

  if (ruleJson.equals && typeof ruleJson.equals === "object") {
    for (const [k, v] of Object.entries(ruleJson.equals)) {
      if (dimensionJson?.[k] !== v) return false;
    }
    return true;
  }
  if (Array.isArray(ruleJson.anyOf)) {
    return ruleJson.anyOf.some((r) => matchesRule(r, dimensionJson));
  }
  if (Array.isArray(ruleJson.allOf)) {
    return ruleJson.allOf.every((r) => matchesRule(r, dimensionJson));
  }
  return false;
}

async function loadRules({ organizationId, userId }) {
  // Pull user roles
  const roleRows = await pool.query(`SELECT role_id FROM user_roles WHERE user_id=$1`, [userId]);
  const roleIds = roleRows.rows.map((r) => r.role_id);

  const { rows } = await pool.query(
    `
    SELECT principal_type, principal_id, effect, rule_json
    FROM dimension_access_rules
    WHERE organization_id=$1
      AND (
        (principal_type='user' AND principal_id=$2)
        OR (principal_type='role' AND principal_id = ANY($3::uuid[]))
      )
    `,
    [organizationId, userId, roleIds]
  );

  return rows;
}

async function enforceDimensionAccess(req, res, next) {
  try {
    const user = req.user;
    if (!user) return next();

    // Look for dimensionJson in either query or body.
    const dim = safeParseJson(req.query.dimensionJson ?? req.body?.dimensionJson ?? null);
    if (!dim || typeof dim !== "object") return next();

    const organizationId = user.organization_id;
    const userId = user.id;

    const rules = await loadRules({ organizationId, userId });
    if (!rules.length) return next();

    const denyRules = rules.filter((r) => r.effect === "deny");
    const allowRules = rules.filter((r) => r.effect === "allow");

    // Any matching deny => forbidden
    if (denyRules.some((r) => matchesRule(r.rule_json, dim))) {
      throw new AppError(403, "Forbidden by dimension access policy");
    }

    // If there are allow rules, at least one must match.
    if (allowRules.length > 0 && !allowRules.some((r) => matchesRule(r.rule_json, dim))) {
      throw new AppError(403, "Forbidden by dimension access policy");
    }

    return next();
  } catch (e) {
    return next(e);
  }
}

module.exports = { enforceDimensionAccess };
