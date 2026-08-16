const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

const ws = require('ws');
global.WebSocket = ws;

// Supabase setup
const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || '';
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false }
});

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// Rate limiters
const createPaymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // limit each IP to 20 requests per windowMs
  message: { success: false, message: 'Too many payment requests, please try again later.' }
});

const verifyPaymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { success: false, message: 'Too many verification attempts, please try again later.' }
});

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'match-code-payment' });
});

const merchantPA = process.env.MERCHANT_PA || '6383617697@fam';
const merchantName = process.env.MERCHANT_NAME || 'Match Code Digital';
const amount = process.env.PRODUCT_AMOUNT || '19.00';
const currency = 'INR';
const note = process.env.PRODUCT_NOTE || '100+ Premium Lightroom Presets';
const downloadRedirectUrl = process.env.DOWNLOAD_URL || 'https://drive.google.com/file/d/16Rax3I-RVXKZg-XFgcAkoaiA0hlESSJ-/view';

const adminUser = {
  username: process.env.ADMIN_USERNAME || 'ADMIN',
  password: process.env.ADMIN_PASSWORD || 'marsh'
};

const sessions = new Map();
const authCookieName = 'adminAuth';

function parseCookies(req) {
  const header = req.headers.cookie || '';
  return header.split(';').reduce((cookies, pair) => {
    const [name, ...rest] = pair.trim().split('=');
    if (!name) return cookies;
    cookies[name] = rest.join('=');
    return cookies;
  }, {});
}

function getAuthToken(req) {
  const cookies = parseCookies(req);
  return cookies[authCookieName] || null;
}

function authMiddleware(req, res, next) {
  const token = getAuthToken(req);
  if (!token || !sessions.has(token)) {
    if (req.path === '/admin' || req.path === '/admin.html') {
      return res.redirect('/login.html');
    }
    return res.status(401).json({ success: false, message: 'Unauthorized. Please login.' });
  }
  next();
}

function generateId(length = 16) {
  return crypto.randomBytes(length).toString('hex');
}

function createUpiUri(orderId) {
  const params = new URLSearchParams({
    pa: merchantPA,
    pn: merchantName,
    tn: note,
    am: amount,
    cu: currency,
    tr: orderId
  });
  return `upi://pay?${params.toString()}`;
}

function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0].trim() ||
         req.headers['x-real-ip'] ||
         req.socket.remoteAddress ||
         'Unknown';
}

function parseUserAgent(userAgent) {
  if (!userAgent) return { browser: 'Unknown', os: 'Unknown', device: 'Unknown' };

  const ua = userAgent.toLowerCase();
  let browser = 'Unknown', os = 'Unknown', device = 'Unknown';

  if (ua.includes('firefox')) browser = 'Firefox';
  else if (ua.includes('chrome')) browser = 'Chrome';
  else if (ua.includes('safari')) browser = 'Safari';
  else if (ua.includes('edge')) browser = 'Edge';
  else if (ua.includes('opera')) browser = 'Opera';

  if (ua.includes('windows')) os = 'Windows';
  else if (ua.includes('mac')) os = 'macOS';
  else if (ua.includes('linux')) os = 'Linux';
  else if (ua.includes('android')) os = 'Android';
  else if (ua.includes('iphone') || ua.includes('ipad')) os = 'iOS';

  if (ua.includes('mobile') || ua.includes('android') || ua.includes('iphone')) device = 'Mobile';
  else if (ua.includes('tablet') || ua.includes('ipad')) device = 'Tablet';
  else device = 'Desktop';

  return { browser, os, device };
}

async function getGeolocation(ip) {
  try {
    const response = await fetch(`http://ip-api.com/json/${ip}?fields=country,city,isp`).catch(() => null);
    if (response && response.ok) {
      const data = await response.json();
      return {
        country: data.country || 'Unknown',
        city: data.city || 'Unknown',
        isp: data.isp || 'Unknown'
      };
    }
  } catch (e) {
    // Geolocation is optional
  }
  return { country: 'Unknown', city: 'Unknown', isp: 'Unknown' };
}

app.post('/api/create-payment', createPaymentLimiter, async (req, res) => {
  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).json({ success: false, message: 'Server configuration error: Supabase keys missing.' });
  }

  const orderId = generateId(8);
  const token = generateId(12);
  const createdAtMs = Date.now();
  const expiresAtMs = createdAtMs + 15 * 60 * 1000;

  const order = {
    order_id: orderId,
    token,
    amount,
    note,
    verified: false,
    download_count: 0,
    created_at: new Date(createdAtMs).toISOString(),
    expires_at: new Date(expiresAtMs).toISOString(),
    access_events: []
  };

  const { error } = await supabase.from('orders').insert([order]);

  if (error) {
    console.error('Supabase Insert Error:', error);
    return res.status(500).json({ success: false, message: 'Failed to create payment session.' });
  }

  return res.json({
    success: true,
    orderId,
    upiUri: createUpiUri(orderId),
    amount,
    note,
    expiresAt: expiresAtMs
  });
});

app.post('/api/verify-payment', verifyPaymentLimiter, async (req, res) => {
  const { orderId, transactionRef, email } = req.body;

  if (!orderId || !transactionRef) {
    return res.status(400).json({ success: false, message: 'orderId and transactionRef are required.' });
  }

  const { data: order, error } = await supabase.from('orders').select('*').eq('order_id', orderId).maybeSingle();

  if (error || !order) {
    return res.status(404).json({ success: false, message: 'Order not found.' });
  }

  if (Date.now() > new Date(order.expires_at).getTime()) {
    return res.status(410).json({ success: false, message: 'Payment session expired. Please create a new payment request.' });
  }

  if (order.verified) {
    return res.json({
      success: true,
      message: 'Payment already verified.',
      downloadUrl: `/download/${orderId}?token=${order.token}`
    });
  }

  if (typeof transactionRef !== 'string' || transactionRef.trim().length < 4) {
    return res.status(400).json({ success: false, message: 'Enter a valid transaction reference or UPI ID.' });
  }

  const txRefClean = transactionRef.trim();

  // Check if this transaction ref is already used by another order
  const { data: existingTx } = await supabase.from('orders').select('order_id').eq('transaction_ref', txRefClean).maybeSingle();
  if (existingTx && existingTx.order_id !== orderId) {
    return res.status(400).json({ success: false, message: 'This transaction reference has already been used.' });
  }

  let validEmail = null;
  if (email && typeof email === 'string' && email.trim().length > 0) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (emailRegex.test(email.trim())) {
      validEmail = email.trim().toLowerCase();
    }
  }

  const clientIP = getClientIP(req);
  const userAgent = req.headers['user-agent'] || 'Unknown';
  const deviceInfo = parseUserAgent(userAgent);
  const geolocation = await getGeolocation(clientIP);
  const verificationTimeMs = Date.now();
  const timeToVerifyMs = verificationTimeMs - new Date(order.created_at).getTime();

  const accessEvents = order.access_events || [];
  accessEvents.push({
    type: 'payment_verified',
    at: new Date(verificationTimeMs).toISOString(),
    ip: clientIP,
    userAgent
  });

  const { error: updateError } = await supabase.from('orders').update({
    verified: true,
    verified_at: new Date(verificationTimeMs).toISOString(),
    transaction_ref: txRefClean,
    email: validEmail,
    client_ip: clientIP,
    user_agent: userAgent,
    device_info: deviceInfo,
    geolocation: geolocation,
    time_to_verify_ms: timeToVerifyMs,
    access_events: accessEvents
  }).eq('order_id', orderId);

  if (updateError) {
    console.error('Supabase Update Error:', updateError);
    return res.status(500).json({ success: false, message: 'Failed to verify payment. Please try again.' });
  }

  return res.json({
    success: true,
    message: 'Payment verification accepted. You may now download your presets.',
    downloadUrl: `/download/${orderId}?token=${order.token}`
  });
});

app.get('/download/:orderId', async (req, res) => {
  const { orderId } = req.params;
  const { token } = req.query;

  const { data: order } = await supabase.from('orders').select('*').eq('order_id', orderId).maybeSingle();

  if (!order || !token || token !== order.token) {
    return res.status(403).send('Unauthorized download request.');
  }

  if (!order.verified) {
    return res.status(402).send('Payment not verified yet.');
  }

  const clientIP = getClientIP(req);
  const userAgent = req.headers['user-agent'] || 'Unknown';
  
  const accessEvents = order.access_events || [];
  accessEvents.push({
    type: 'downloaded',
    at: new Date().toISOString(),
    ip: clientIP,
    userAgent
  });

  await supabase.from('orders').update({
    download_count: (order.download_count || 0) + 1,
    last_download_at: new Date().toISOString(),
    last_download_ip: clientIP,
    access_events: accessEvents
  }).eq('order_id', orderId);

  return res.redirect(downloadRedirectUrl);
});

app.post('/api/admin-login', (req, res) => {
  const { username, password } = req.body;
  if (username !== adminUser.username || password !== adminUser.password) {
    return res.status(401).json({ success: false, message: 'Invalid username or password.' });
  }

  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { createdAt: Date.now() });
  res.setHeader('Set-Cookie', `${authCookieName}=${token}; HttpOnly; Path=/; SameSite=Lax`);

  return res.json({ success: true, message: 'Login successful.' });
});

app.post('/api/admin-logout', authMiddleware, (req, res) => {
  const token = getAuthToken(req);
  if (token) {
    sessions.delete(token);
  }
  res.setHeader('Set-Cookie', `${authCookieName}=; HttpOnly; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax`);
  return res.json({ success: true, message: 'Logged out.' });
});

app.get('/api/stats', authMiddleware, async (req, res) => {
  const { count: verifiedCount } = await supabase.from('orders').select('*', { count: 'exact', head: true }).eq('verified', true);
  const { count: totalCount } = await supabase.from('orders').select('*', { count: 'exact', head: true });
  
  const { data: downloadsData } = await supabase.from('orders').select('download_count').eq('verified', true);
  const totalDownloads = downloadsData ? downloadsData.reduce((acc, curr) => acc + (curr.download_count || 0), 0) : 0;

  return res.json({
    success: true,
    stats: {
      paymentsVerified: verifiedCount || 0,
      downloads: totalDownloads,
      activeOrders: totalCount || 0
    }
  });
});

app.get('/api/orders', authMiddleware, async (req, res) => {
  const { data: ordersData, error } = await supabase.from('orders').select('*').order('created_at', { ascending: false });
  
  if (error) {
    return res.status(500).json({ success: false, message: 'Error fetching orders' });
  }

  const orderList = ordersData.map(order => ({
    orderId: order.order_id,
    verified: order.verified,
    transactionRef: order.transaction_ref || null,
    downloadCount: order.download_count,
    createdAt: new Date(order.created_at).getTime(),
    verifiedAt: order.verified_at ? new Date(order.verified_at).getTime() : null,
    expiresAt: new Date(order.expires_at).getTime(),
    email: order.email || null,
    clientIP: order.client_ip || null,
    deviceInfo: order.device_info || { browser: 'Unknown', os: 'Unknown', device: 'Unknown' },
    geolocation: order.geolocation || { country: 'Unknown', city: 'Unknown', isp: 'Unknown' },
    timeToVerifyMin: order.time_to_verify_ms ? Math.round(order.time_to_verify_ms / 60000 * 10) / 10 : null,
    userAgent: order.user_agent || null,
    lastDownloadAt: order.last_download_at ? new Date(order.last_download_at).getTime() : null,
    lastDownloadIP: order.last_download_ip || null,
    accessEvents: order.access_events || []
  }));

  return res.json({
    success: true,
    orders: orderList
  });
});

app.get('/admin', authMiddleware, (req, res) => {
  return res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('/admin.html', authMiddleware, (req, res) => {
  return res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname, '.')));

function startServer() {
  return app.listen(PORT, HOST, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log('Open index.html through the server or use the browser to visit the page after starting the backend.');
  });
}

if (require.main === module) {
  startServer();
}

module.exports = app;
