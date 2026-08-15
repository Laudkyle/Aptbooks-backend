const crypto = require('crypto');
const { pool } = require('../../../db/pool');
const { env } = require('../../../config/env');
const { AppError } = require('../../../shared/errors/AppError');
const { sendOrganizationEmail } = require('../../../shared/email/smtpMailer');

const CHALLENGE_TTL_MINUTES = 10;
const RESEND_COOLDOWN_SECONDS = 30;
const MAX_ATTEMPTS = 5;

function maskEmail(email) {
  const [local, domain] = String(email || '').split('@');
  if (!domain) return 'your email';
  const visible = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
  return `${visible}${'*'.repeat(Math.max(2, Math.min(6, local.length - visible.length)))}@${domain}`;
}

function otpPepper() {
  return String(env.APP_SECRETS_ENCRYPTION_KEY || env.PASSWORD_RESET_TOKEN_PEPPER || env.JWT_SECRET || 'aptbooks-email-2fa');
}

function hashCode({ challengeId, code }) {
  return crypto.createHmac('sha256', otpPepper()).update(`${challengeId}:${String(code)}`).digest('hex');
}

function verificationEmail({ code, purpose, organizationName }) {
  const action = purpose === 'enable'
    ? 'enable email verification on your account'
    : purpose === 'disable'
      ? 'disable email verification on your account'
      : 'complete your sign in';
  const safeOrg = String(organizationName || 'AptBooks').replace(/[<>]/g, '');
  return {
    subject: `Your AptBooks verification code: ${code}`,
    text: `Your AptBooks verification code is ${code}. Use it to ${action}. It expires in ${CHALLENGE_TTL_MINUTES} minutes. If you did not request this, you can ignore this email.`,
    html: `
      <div style="font-family:Inter,Arial,sans-serif;background:#f8fafc;padding:32px;color:#0f172a">
        <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:18px;padding:28px">
          <div style="font-size:12px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:#64748b">${safeOrg}</div>
          <h1 style="margin:10px 0 8px;font-size:22px">Email verification</h1>
          <p style="margin:0 0 22px;color:#475569;line-height:1.6">Use this code to ${action}.</p>
          <div style="font-size:34px;font-weight:800;letter-spacing:.22em;padding:18px 20px;border-radius:14px;background:#f1f5f9;text-align:center">${code}</div>
          <p style="margin:22px 0 0;color:#64748b;font-size:13px;line-height:1.6">The code expires in ${CHALLENGE_TTL_MINUTES} minutes. If you did not request it, you can safely ignore this email.</p>
        </div>
      </div>`,
  };
}

async function issueEmailTwoFactorChallenge({ orgId, userId, email, purpose }) {
  if (!['login', 'enable', 'disable'].includes(purpose)) throw new AppError(400, 'Invalid verification purpose');
  const challengeId = crypto.randomUUID();
  const code = String(crypto.randomInt(100000, 1000000));

  const { rows: orgRows } = await pool.query(`SELECT name FROM organizations WHERE id=$1`, [orgId]);
  if (!orgRows.length) throw new AppError(404, 'Organization not found');

  const { rows: recent } = await pool.query(
    `SELECT created_at
       FROM email_two_factor_challenges
      WHERE organization_id=$1 AND user_id=$2 AND purpose=$3 AND consumed_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1`,
    [orgId, userId, purpose]
  );
  if (recent.length) {
    const ageMs = Date.now() - new Date(recent[0].created_at).getTime();
    if (Number.isFinite(ageMs) && ageMs < RESEND_COOLDOWN_SECONDS * 1000) {
      throw new AppError(429, `Please wait ${RESEND_COOLDOWN_SECONDS} seconds before requesting another code`);
    }
  }

  await pool.query(
    `UPDATE email_two_factor_challenges
        SET consumed_at=COALESCE(consumed_at, NOW())
      WHERE organization_id=$1 AND user_id=$2 AND purpose=$3 AND consumed_at IS NULL`,
    [orgId, userId, purpose]
  );

  await pool.query(
    `INSERT INTO email_two_factor_challenges
      (id, organization_id, user_id, purpose, code_hash, expires_at, max_attempts)
     VALUES ($1,$2,$3,$4,$5,NOW() + ($6 || ' minutes')::interval,$7)`,
    [challengeId, orgId, userId, purpose, hashCode({ challengeId, code }), CHALLENGE_TTL_MINUTES, MAX_ATTEMPTS]
  );

  try {
    const emailBody = verificationEmail({ code, purpose, organizationName: orgRows[0].name });
    await sendOrganizationEmail({ orgId, to: email, ...emailBody });
  } catch (err) {
    await pool.query(`DELETE FROM email_two_factor_challenges WHERE id=$1`, [challengeId]).catch(() => {});
    throw err;
  }

  return {
    challengeId,
    method: 'email',
    maskedEmail: maskEmail(email),
    expiresInSeconds: CHALLENGE_TTL_MINUTES * 60,
  };
}

async function verifyEmailTwoFactorChallenge({ orgId, userId, challengeId, code, purpose }) {
  if (!challengeId || !code) throw new AppError(400, 'challengeId and code required');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, code_hash, expires_at, attempts, max_attempts, consumed_at
         FROM email_two_factor_challenges
        WHERE id=$1 AND organization_id=$2 AND user_id=$3 AND purpose=$4
        FOR UPDATE`,
      [challengeId, orgId, userId, purpose]
    );
    if (!rows.length) throw new AppError(400, 'Invalid or expired verification code');
    const row = rows[0];
    if (row.consumed_at || new Date(row.expires_at).getTime() <= Date.now() || Number(row.attempts) >= Number(row.max_attempts)) {
      throw new AppError(400, 'Invalid or expired verification code');
    }

    const supplied = hashCode({ challengeId, code });
    const expected = String(row.code_hash);
    const valid = expected.length === supplied.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
    if (!valid) {
      const nextAttempts = Number(row.attempts) + 1;
      await client.query(
        `UPDATE email_two_factor_challenges
            SET attempts=attempts+1,
                consumed_at=CASE WHEN attempts+1 >= max_attempts THEN NOW() ELSE consumed_at END
          WHERE id=$1`,
        [challengeId]
      );
      await client.query('COMMIT');
      throw new AppError(400, nextAttempts >= Number(row.max_attempts) ? 'Verification code locked after too many attempts' : 'Invalid verification code');
    }

    await client.query(
      `UPDATE email_two_factor_challenges SET consumed_at=NOW(), attempts=attempts+1 WHERE id=$1`,
      [challengeId]
    );
    await client.query('COMMIT');
    return { ok: true };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  issueEmailTwoFactorChallenge,
  verifyEmailTwoFactorChallenge,
  maskEmail,
  CHALLENGE_TTL_MINUTES,
};
