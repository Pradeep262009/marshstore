const test = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('./server');

test('full payment flow', async () => {
  const server = app.listen(0, '127.0.0.1');
  
  try {
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });

    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    // 1. Create Payment
    const createRes = await fetch(`${baseUrl}/api/create-payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const createBody = await createRes.json();
    assert.equal(createBody.success, true);
    assert.ok(createBody.orderId);

    const orderId = createBody.orderId;

    // 2. Verify Payment (invalid)
    const verifyFailRes = await fetch(`${baseUrl}/api/verify-payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId, transactionRef: '123' })
    });
    const verifyFailBody = await verifyFailRes.json();
    assert.equal(verifyFailBody.success, false);

    // 3. Verify Payment (valid string length >= 4)
    const verifyPassRes = await fetch(`${baseUrl}/api/verify-payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId, transactionRef: 'VALID_TXN_12345' })
    });
    const verifyPassBody = await verifyPassRes.json();
    assert.equal(verifyPassBody.success, true);
    assert.ok(verifyPassBody.downloadUrl);

    // 4. Download
    const downloadRes = await fetch(`${baseUrl}${verifyPassBody.downloadUrl}`, {
      redirect: 'manual'
    });
    assert.equal(downloadRes.status, 302); // Redirects to Google Drive
  } finally {
    await new Promise((resolve, reject) => {
      server.close(err => (err ? reject(err) : resolve()));
    });
  }
});
