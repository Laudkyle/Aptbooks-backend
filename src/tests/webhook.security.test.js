const { assertSafeWebhookUrl } = require('../modules/webhooks/webhooks.service');

test.each([
  'http://127.0.0.1/hook',
  'http://10.0.0.2/hook',
  'http://169.254.169.254/latest/meta-data',
  'http://localhost/hook',
  'file:///etc/passwd',
])('webhook destination rejects local/private target %s', async (url) => {
  await expect(assertSafeWebhookUrl(url)).rejects.toBeTruthy();
});
