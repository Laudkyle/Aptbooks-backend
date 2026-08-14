const { bootstrapTenant, destroyTenant, request, app, pool } = require('./helpers/accountingTestContext');
let ctx;

beforeAll(async () => { ctx = await bootstrapTenant(); }, 120000);
afterAll(async () => { await destroyTenant(ctx); await pool.end(); });

test('login issues a usable refresh session and concurrent reuse is rejected', async () => {
  expect(ctx.refreshToken).toBeTruthy();

  const [a, b] = await Promise.all([
    request(app).post('/auth/refresh').send({ refreshToken: ctx.refreshToken }),
    request(app).post('/auth/refresh').send({ refreshToken: ctx.refreshToken }),
  ]);
  const successes = [a, b].filter((r) => r.status === 200);
  const rejected = [a, b].filter((r) => r.status === 401 || r.status === 409);
  expect(successes).toHaveLength(1);
  expect(rejected).toHaveLength(1);

  const oldAgain = await request(app).post('/auth/refresh').send({ refreshToken: ctx.refreshToken });
  expect(oldAgain.status).toBe(401);
});

test('logout revokes refresh token', async () => {
  const login = await request(app).post('/auth/login').send({ email: ctx.email, password: ctx.password });
  const cookie = login.headers['set-cookie'] || [];
  const token = login.body.refreshToken || (cookie[0] ? decodeURIComponent(cookie[0].split(';')[0].split('=').slice(1).join('=')) : null);
  expect(token).toBeTruthy();

  const logout = await request(app).post('/auth/logout').send({ refreshToken: token });
  expect(logout.status).toBe(200);
  const refresh = await request(app).post('/auth/refresh').send({ refreshToken: token });
  expect(refresh.status).toBe(401);
});
