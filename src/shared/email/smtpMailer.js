const net = require('net');
const tls = require('tls');
const { pool } = require('../../db/pool');
const { AppError } = require('../errors/AppError');
const { decryptSecret } = require('../security/secrets');

function assertHeaderSafe(value, field) {
  const s = String(value || '').trim();
  if (!s || /[\r\n]/.test(s)) throw new AppError(400, `${field} is invalid`);
  return s;
}

function extractAddress(value) {
  const s = assertHeaderSafe(value, 'email address');
  const match = s.match(/<([^<>]+)>\s*$/);
  return (match ? match[1] : s).trim();
}

class SmtpSession {
  constructor(socket) {
    this.socket = socket;
    this.buffer = '';
    this.lines = [];
    this.waiters = [];
    this.error = null;
    this.onData = (chunk) => {
      this.buffer += chunk.toString('utf8');
      let idx;
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx + 1).replace(/\r?\n$/, '');
        this.buffer = this.buffer.slice(idx + 1);
        const waiter = this.waiters.shift();
        if (waiter) waiter.resolve(line);
        else this.lines.push(line);
      }
    };
    this.onError = (err) => {
      this.error = err;
      while (this.waiters.length) this.waiters.shift().reject(err);
    };
    socket.on('data', this.onData);
    socket.on('error', this.onError);
  }

  detach() {
    this.socket.off('data', this.onData);
    this.socket.off('error', this.onError);
  }

  nextLine(timeoutMs = 12000) {
    if (this.error) return Promise.reject(this.error);
    if (this.lines.length) return Promise.resolve(this.lines.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.resolve === wrappedResolve);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error('SMTP response timed out'));
      }, timeoutMs);
      const wrappedResolve = (line) => {
        clearTimeout(timer);
        resolve(line);
      };
      const wrappedReject = (err) => {
        clearTimeout(timer);
        reject(err);
      };
      this.waiters.push({ resolve: wrappedResolve, reject: wrappedReject });
    });
  }

  async readResponse() {
    const first = await this.nextLine();
    const match = first.match(/^(\d{3})([ -])(.*)$/);
    if (!match) throw new Error(`Invalid SMTP response: ${first}`);
    const code = Number(match[1]);
    const lines = [first];
    if (match[2] === '-') {
      while (true) {
        const line = await this.nextLine();
        lines.push(line);
        if (line.startsWith(`${match[1]} `)) break;
      }
    }
    return { code, text: lines.join('\n') };
  }

  async command(command, expectedCodes) {
    this.socket.write(`${command}\r\n`);
    const response = await this.readResponse();
    const expected = Array.isArray(expectedCodes) ? expectedCodes : [expectedCodes];
    if (!expected.includes(response.code)) {
      throw new Error(`SMTP command failed (${response.code}): ${response.text}`);
    }
    return response;
  }
}

function connectPlain({ host, port }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('SMTP connection timed out'));
    }, 12000);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function connectTls({ host, port, socket = undefined }) {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ host: socket ? undefined : host, port: socket ? undefined : port, socket, servername: host, rejectUnauthorized: true });
    const timer = setTimeout(() => {
      secure.destroy();
      reject(new Error('SMTP TLS connection timed out'));
    }, 12000);
    secure.once('secureConnect', () => {
      clearTimeout(timer);
      resolve(secure);
    });
    secure.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function encodeMessage({ from, to, subject, text, html }) {
  const safeFrom = assertHeaderSafe(from, 'from');
  const safeTo = assertHeaderSafe(to, 'to');
  const safeSubject = assertHeaderSafe(subject, 'subject');
  const body = html || String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br/>');
  const headers = [
    `From: ${safeFrom}`,
    `To: ${safeTo}`,
    `Subject: ${safeSubject}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    body,
  ];
  return headers.join('\r\n').replace(/^\./gm, '..');
}

async function sendSmtpMail({ host, port, username, password, from, to, subject, text, html }) {
  const smtpHost = String(host || '').trim();
  const smtpPort = Number(port || 587);
  if (!smtpHost) throw new AppError(409, 'SMTP host is not configured');
  if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) throw new AppError(409, 'SMTP port is invalid');

  let socket = smtpPort === 465
    ? await connectTls({ host: smtpHost, port: smtpPort })
    : await connectPlain({ host: smtpHost, port: smtpPort });
  let session = new SmtpSession(socket);

  try {
    let response = await session.readResponse();
    if (response.code !== 220) throw new Error(`SMTP greeting rejected: ${response.text}`);

    await session.command('EHLO aptbooks.local', 250);

    if (smtpPort !== 465) {
      await session.command('STARTTLS', 220);
      session.detach();
      socket = await connectTls({ host: smtpHost, socket });
      session = new SmtpSession(socket);
      await session.command('EHLO aptbooks.local', 250);
    }

    if (username) {
      await session.command('AUTH LOGIN', 334);
      await session.command(Buffer.from(String(username), 'utf8').toString('base64'), 334);
      await session.command(Buffer.from(String(password || ''), 'utf8').toString('base64'), 235);
    }

    await session.command(`MAIL FROM:<${extractAddress(from)}>`, 250);
    await session.command(`RCPT TO:<${extractAddress(to)}>`, [250, 251]);
    await session.command('DATA', 354);
    socket.write(`${encodeMessage({ from, to, subject, text, html })}\r\n.\r\n`);
    response = await session.readResponse();
    if (response.code !== 250) throw new Error(`SMTP DATA rejected: ${response.text}`);
    await session.command('QUIT', 221).catch(() => {});
    return { ok: true };
  } finally {
    session.detach();
    if (!socket.destroyed) socket.end();
  }
}

async function loadOrganizationSmtp(orgId) {
  const { rows } = await pool.query(
    `SELECT value_json FROM system_settings WHERE organization_id=$1 AND key='smtp' LIMIT 1`,
    [orgId]
  );
  const cfg = rows[0]?.value_json || null;
  if (!cfg?.appPassword || !cfg?.host || !cfg?.from || !cfg?.username) {
    throw new AppError(409, 'Email delivery is not configured for this organization. Configure SMTP in System Settings first.');
  }
  return {
    host: cfg.host,
    port: Number(cfg.port || 587),
    from: cfg.from,
    username: cfg.username,
    password: decryptSecret(cfg.appPassword, { context: `smtp:${orgId}`, allowPlaintextLegacy: true }),
  };
}

async function sendOrganizationEmail({ orgId, to, subject, text, html }) {
  const cfg = await loadOrganizationSmtp(orgId);
  try {
    return await sendSmtpMail({ ...cfg, to, subject, text, html });
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(503, 'Email delivery failed. Verify the SMTP settings and try again.');
  }
}

module.exports = { sendSmtpMail, sendOrganizationEmail, loadOrganizationSmtp };
