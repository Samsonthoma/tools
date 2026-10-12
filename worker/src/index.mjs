const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com';
const GOOGLE_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const FREE_LIMIT = 7;
const TOPUP_AMOUNT = 4900;
const TOPUP_REQUESTS = 50;
const SUBSCRIPTION_AMOUNT = 19900;
const SUBSCRIPTION_REQUESTS = 500;
const SUBSCRIPTION_DAYS = 30;
const MAX_BODY_SIZE = 1024 * 1024;
const ALLOWED_MODELS = new Set([
  'gemini-3-flash-preview',
  'gemini-2.5-flash-preview-tts',
  'gemini-3.1-flash-image'
]);

let googleKeys;
let googleKeysExpiresAt = 0;

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers }
  });
}

function corsHeaders(origin, env) {
  if (origin !== env.SITE_ORIGIN) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Razorpay-Signature',
    'Access-Control-Expose-Headers': 'X-Quota-Status',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
  };
}

function base64UrlToBytes(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

function decodeJwtPart(value) {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(value)));
}

async function loadGoogleKeys(forceRefresh = false) {
  if (!forceRefresh && googleKeys && Date.now() < googleKeysExpiresAt) return googleKeys;
  const response = await fetch(GOOGLE_CERTS_URL);
  if (!response.ok) throw new Error('Unable to retrieve Google signing keys');
  const data = await response.json();
  googleKeys = data.keys || [];
  googleKeysExpiresAt = Date.now() + 60 * 60 * 1000;
  return googleKeys;
}

async function verifyGoogleIdToken(token, clientId) {
  const segments = token.split('.');
  if (segments.length !== 3) throw new Error('Invalid Google sign-in token');
  const [encodedHeader, encodedClaims, encodedSignature] = segments;
  const header = decodeJwtPart(encodedHeader);
  const claims = decodeJwtPart(encodedClaims);
  if (header.alg !== 'RS256' || !header.kid) throw new Error('Invalid Google token signature');
  const keys = await loadGoogleKeys();
  let jwk = keys.find(key => key.kid === header.kid);
  if (!jwk) jwk = (await loadGoogleKeys(true)).find(key => key.kid === header.kid);
  if (!jwk) throw new Error('Unknown Google token signing key');
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );
  const validSignature = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    publicKey,
    base64UrlToBytes(encodedSignature),
    new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`)
  );
  const now = Math.floor(Date.now() / 1000);
  const validIssuer = ['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss);
  const validAudience = Array.isArray(claims.aud)
    ? claims.aud.includes(clientId)
    : claims.aud === clientId;
  if (!validSignature || !validIssuer || !validAudience || !claims.sub ||
      !claims.email || claims.email_verified !== true || claims.exp <= now ||
      claims.iat > now + 60) {
    throw new Error('Google sign-in token is invalid or expired');
  }
  return { id: claims.sub, email: claims.email, name: claims.name || '' };
}

async function authenticate(request, env) {
  const authorization = request.headers.get('Authorization') || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const user = await verifyGoogleIdToken(match[1], env.GOOGLE_CLIENT_ID);
  await env.DB.prepare(`
    INSERT INTO users (user_id, email, name)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      email = excluded.email,
      name = excluded.name,
      last_login_at = CURRENT_TIMESTAMP
  `).bind(user.id, user.email, user.name).run();
  return user;
}

function istDate() {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());
  const part = key => parts.find(item => item.type === key).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

async function accountSummary(env, userId) {
  const today = istDate();
  const [usage, user] = await Promise.all([
    env.DB.prepare('SELECT request_count FROM daily_usage WHERE user_id = ? AND usage_date = ?')
      .bind(userId, today).first(),
    env.DB.prepare(`
      SELECT email, name, paid_requests, subscription_requests, subscription_expires_at,
             subscription_status, current_subscription_id
      FROM users WHERE user_id = ?
    `).bind(userId).first()
  ]);
  if (!user) throw new Error('Account not found');
  const subscriptionActive = user.subscription_expires_at &&
    Date.parse(`${user.subscription_expires_at.replace(' ', 'T')}Z`) > Date.now();
  return {
    email: user.email,
    name: user.name,
    freeLimit: FREE_LIMIT,
    freeUsed: usage?.request_count || 0,
    freeRemaining: Math.max(0, FREE_LIMIT - (usage?.request_count || 0)),
    paidRequests: user.paid_requests,
    subscriptionRequests: subscriptionActive ? user.subscription_requests : 0,
    subscriptionExpiresAt: subscriptionActive ? user.subscription_expires_at : null,
    subscriptionStatus: user.subscription_status,
    subscriptionId: user.current_subscription_id
  };
}

async function reserveUsage(env, userId) {
  const today = istDate();
  await env.DB.prepare('INSERT OR IGNORE INTO daily_usage (user_id, usage_date) VALUES (?, ?)')
    .bind(userId, today).run();
  const free = await env.DB.prepare(`
    UPDATE daily_usage SET request_count = request_count + 1
    WHERE user_id = ? AND usage_date = ? AND request_count < ?
    RETURNING request_count
  `).bind(userId, today, FREE_LIMIT).first();
  if (free) return { type: 'free', userId, today };

  const subscription = await env.DB.prepare(`
    UPDATE users SET subscription_requests = subscription_requests - 1
    WHERE user_id = ? AND subscription_requests > 0
      AND subscription_expires_at > CURRENT_TIMESTAMP
    RETURNING subscription_requests
  `).bind(userId).first();
  if (subscription) return { type: 'subscription', userId };

  const paid = await env.DB.prepare(`
    UPDATE users SET paid_requests = paid_requests - 1
    WHERE user_id = ? AND paid_requests > 0
    RETURNING paid_requests
  `).bind(userId).first();
  if (paid) return { type: 'paid', userId };
  return null;
}

async function refundUsage(env, reservation) {
  if (reservation.type === 'free') {
    await env.DB.prepare(`
      UPDATE daily_usage SET request_count = MAX(0, request_count - 1)
      WHERE user_id = ? AND usage_date = ?
    `).bind(reservation.userId, reservation.today).run();
  } else if (reservation.type === 'subscription') {
    await env.DB.prepare(`
      UPDATE users SET subscription_requests = subscription_requests + 1 WHERE user_id = ?
    `).bind(reservation.userId).run();
  } else {
    await env.DB.prepare(`
      UPDATE users SET paid_requests = paid_requests + 1 WHERE user_id = ?
    `).bind(reservation.userId).run();
  }
}

function bytesToHex(bytes) {
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return bytesToHex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
}

function constantTimeEqual(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i++) {
    difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return difference === 0;
}

function razorpayAuthorization(env) {
  return `Basic ${btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`)}`;
}

async function razorpayRequest(env, path, { method = 'GET', body } = {}) {
  const response = await fetch(`https://api.razorpay.com/v1${path}`, {
    method,
    headers: {
      Authorization: razorpayAuthorization(env),
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.description || 'Razorpay request failed');
  return data;
}

async function createTopupOrder(request, env, user) {
  const receipt = `topup_${crypto.randomUUID().replace(/-/g, '')}`;
  const order = await razorpayRequest(env, '/orders', {
    method: 'POST',
    body: {
      amount: TOPUP_AMOUNT,
      currency: 'INR',
      receipt,
      notes: { user_id: user.id, product_type: 'topup' }
    }
  });
  await env.DB.prepare(`
    INSERT INTO payment_orders (order_id, user_id, amount, product_type)
    VALUES (?, ?, ?, 'topup')
  `).bind(order.id, user.id, TOPUP_AMOUNT).run();
  return json({ orderId: order.id, amount: TOPUP_AMOUNT, currency: 'INR', keyId: env.RAZORPAY_KEY_ID });
}

async function getSubscriptionPlan(env) {
  const stored = await env.DB.prepare(
    "SELECT setting_value FROM app_settings WHERE setting_key = 'razorpay_monthly_plan_id'"
  ).first();
  if (stored) return stored.setting_value;
  const plan = await razorpayRequest(env, '/plans', {
    method: 'POST',
    body: {
      period: 'monthly',
      interval: 1,
      item: {
        name: 'StudyCraft AI - 500 requests/month',
        amount: SUBSCRIPTION_AMOUNT,
        currency: 'INR',
        description: '500 AI requests with 30-day access per successful billing cycle'
      }
    }
  });
  await env.DB.prepare(
    "INSERT OR IGNORE INTO app_settings (setting_key, setting_value) VALUES ('razorpay_monthly_plan_id', ?)"
  ).bind(plan.id).run();
  const winner = await env.DB.prepare(
    "SELECT setting_value FROM app_settings WHERE setting_key = 'razorpay_monthly_plan_id'"
  ).first();
  return winner.setting_value;
}

async function createMonthlySubscription(env, user) {
  const planId = await getSubscriptionPlan(env);
  const subscription = await razorpayRequest(env, '/subscriptions', {
    method: 'POST',
    body: {
      plan_id: planId,
      total_count: 1200,
      customer_notify: 1,
      notes: { user_id: user.id }
    }
  });
  await env.DB.prepare(`
    INSERT INTO subscriptions (subscription_id, user_id)
    VALUES (?, ?)
  `).bind(subscription.id, user.id).run();
  await env.DB.prepare(`
    UPDATE users SET current_subscription_id = ?, subscription_status = 'created' WHERE user_id = ?
  `).bind(subscription.id, user.id).run();
  return json({
    subscriptionId: subscription.id,
    keyId: env.RAZORPAY_KEY_ID
  });
}

async function paymentDetails(env, paymentId) {
  return razorpayRequest(env, `/payments/${encodeURIComponent(paymentId)}`);
}

async function creditTopup(env, orderId, payment) {
  const order = await env.DB.prepare(`
    SELECT user_id, amount, status FROM payment_orders WHERE order_id = ?
  `).bind(orderId).first();
  if (!order || order.amount !== TOPUP_AMOUNT || payment.order_id !== orderId ||
      payment.amount !== TOPUP_AMOUNT || payment.currency !== 'INR' || payment.status !== 'captured') {
    throw new Error('Payment does not match the order');
  }
  const results = await env.DB.batch([
    env.DB.prepare(`
      INSERT OR IGNORE INTO processed_payments (payment_id, user_id, payment_type)
      VALUES (?, ?, 'topup')
    `).bind(payment.id, order.user_id),
    env.DB.prepare(`
      UPDATE payment_orders SET status = 'paid', payment_id = ?
      WHERE order_id = ? AND user_id = ? AND status = 'created' AND changes() = 1
    `).bind(payment.id, orderId, order.user_id),
    env.DB.prepare(`
      UPDATE users SET paid_requests = paid_requests + ?
      WHERE user_id = ? AND changes() = 1
    `).bind(TOPUP_REQUESTS, order.user_id)
  ]);
  return results[2]?.meta?.changes === 1;
}

async function creditSubscription(env, subscriptionId, payment) {
  const subscription = await env.DB.prepare(`
    SELECT user_id FROM subscriptions WHERE subscription_id = ?
  `).bind(subscriptionId).first();
  if (!subscription || payment.subscription_id !== subscriptionId ||
      payment.currency !== 'INR' || payment.status !== 'captured' ||
      payment.amount !== SUBSCRIPTION_AMOUNT) {
    throw new Error('Subscription payment does not match');
  }
  const results = await env.DB.batch([
    env.DB.prepare(`
      INSERT OR IGNORE INTO processed_payments (payment_id, user_id, payment_type)
      VALUES (?, ?, 'subscription')
    `).bind(payment.id, subscription.user_id),
    env.DB.prepare(`
      UPDATE users SET subscription_requests = ?,
        subscription_expires_at = datetime('now', '+30 days'),
        subscription_status = 'active'
      WHERE user_id = ? AND changes() = 1
    `).bind(SUBSCRIPTION_REQUESTS, subscription.user_id),
    env.DB.prepare(`
      UPDATE subscriptions SET status = 'active' WHERE subscription_id = ?
    `).bind(subscriptionId)
  ]);
  return results[1]?.meta?.changes === 1;
}

async function verifyTopup(request, env, user) {
  const body = await request.json();
  const { orderId, paymentId, signature } = body;
  if (![orderId, paymentId, signature].every(value => typeof value === 'string' && value.length < 256)) {
    return json({ error: 'Invalid payment details' }, 400);
  }
  const order = await env.DB.prepare(`
    SELECT order_id FROM payment_orders WHERE order_id = ? AND user_id = ?
  `).bind(orderId, user.id).first();
  if (!order) return json({ error: 'Payment order not found' }, 404);
  const expected = await hmacHex(env.RAZORPAY_KEY_SECRET, `${orderId}|${paymentId}`);
  if (!constantTimeEqual(expected, signature)) return json({ error: 'Invalid payment signature' }, 400);
  const payment = await paymentDetails(env, paymentId);
  await creditTopup(env, orderId, payment);
  return json({ account: await accountSummary(env, user.id) });
}

async function verifySubscription(request, env, user) {
  const body = await request.json();
  const { subscriptionId, paymentId, signature } = body;
  if (![subscriptionId, paymentId, signature].every(value => typeof value === 'string' && value.length < 256)) {
    return json({ error: 'Invalid subscription payment details' }, 400);
  }
  const subscription = await env.DB.prepare(`
    SELECT subscription_id FROM subscriptions
    WHERE subscription_id = ? AND user_id = ?
  `).bind(subscriptionId, user.id).first();
  if (!subscription) return json({ error: 'Subscription not found' }, 404);
  const expected = await hmacHex(env.RAZORPAY_KEY_SECRET, `${paymentId}|${subscriptionId}`);
  if (!constantTimeEqual(expected, signature)) return json({ error: 'Invalid payment signature' }, 400);
  const payment = await paymentDetails(env, paymentId);
  await creditSubscription(env, subscriptionId, payment);
  return json({ account: await accountSummary(env, user.id), paymentPending: payment.status !== 'captured' });
}

async function cancelSubscription(env, user) {
  const current = await env.DB.prepare(`
    SELECT current_subscription_id FROM users WHERE user_id = ?
  `).bind(user.id).first();
  if (!current?.current_subscription_id) return json({ error: 'No subscription to cancel' }, 404);
  await razorpayRequest(env, `/subscriptions/${encodeURIComponent(current.current_subscription_id)}/cancel`, {
    method: 'POST',
    body: { cancel_at_cycle_end: 1 }
  });
  await env.DB.prepare(`
    UPDATE subscriptions SET status = 'cancelled' WHERE subscription_id = ? AND user_id = ?
  `).bind(current.current_subscription_id, user.id).run();
  await env.DB.prepare(`
    UPDATE users SET subscription_status = 'cancelled' WHERE user_id = ?
  `).bind(user.id).run();
  return json({ account: await accountSummary(env, user.id) });
}

async function handleWebhook(request, env) {
  const rawBody = await request.text();
  const signature = request.headers.get('X-Razorpay-Signature') || '';
  const eventId = request.headers.get('X-Razorpay-Event-Id');
  const expected = await hmacHex(env.RAZORPAY_WEBHOOK_SECRET, rawBody);
  if (!constantTimeEqual(expected, signature) || !eventId) {
    return json({ error: 'Invalid webhook signature' }, 400);
  }
  const results = await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO webhook_events (event_id) VALUES (?)').bind(eventId)
  ]);
  if (results[0]?.meta?.changes !== 1) return json({ received: true, duplicate: true });

  const event = JSON.parse(rawBody);
  const subscription = event.payload?.subscription?.entity;
  if (event.event === 'payment.captured') {
    const payment = event.payload?.payment?.entity;
    if (payment?.order_id) {
      await creditTopup(env, payment.order_id, payment);
    } else if (payment?.subscription_id) {
      await creditSubscription(env, payment.subscription_id, payment);
    }
  } else if (event.event === 'subscription.charged') {
    const payment = event.payload?.payment?.entity;
    if (payment?.id && subscription?.id) {
      await creditSubscription(env, subscription.id, payment);
    }
  } else if (['subscription.cancelled', 'subscription.halted', 'subscription.completed'].includes(event.event) && subscription?.id) {
    const status = event.event === 'subscription.cancelled'
      ? 'cancelled'
      : event.event === 'subscription.halted' ? 'halted' : 'completed';
    await env.DB.batch([
      env.DB.prepare('UPDATE subscriptions SET status = ? WHERE subscription_id = ?').bind(status, subscription.id),
      env.DB.prepare('UPDATE users SET subscription_status = ? WHERE user_id = (SELECT user_id FROM subscriptions WHERE subscription_id = ?)').bind(status, subscription.id)
    ]);
  }
  return json({ received: true });
}

async function handleGemini(request, env, user, url) {
  const match = url.pathname.match(/^\/v1beta\/models\/([A-Za-z0-9.-]+):generateContent$/);
  if (!match || !ALLOWED_MODELS.has(match[1])) return json({ error: 'Unsupported AI model' }, 404);
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > MAX_BODY_SIZE) return json({ error: 'Request too large' }, 413);
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BODY_SIZE) return json({ error: 'Request too large' }, 413);
  try {
    JSON.parse(new TextDecoder().decode(body));
  } catch {
    return json({ error: 'Invalid JSON request' }, 400);
  }

  const reservation = await reserveUsage(env, user.id);
  if (!reservation) {
    return json({
      error: 'quota_exceeded',
      message: 'Your free requests and paid request balance are used up. Choose a plan to continue.'
    }, 429);
  }
  try {
    const upstream = await fetch(`${GEMINI_BASE_URL}${url.pathname}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': env.GEMINI_API_KEY
      },
      body
    });
    if (!upstream.ok) {
      await refundUsage(env, reservation);
      return new Response(await upstream.arrayBuffer(), {
        status: upstream.status,
        headers: { 'Content-Type': upstream.headers.get('Content-Type') || 'application/json' }
      });
    }
    return new Response(await upstream.arrayBuffer(), {
      status: upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('Content-Type') || 'application/json',
        'X-Quota-Status': JSON.stringify(await accountSummary(env, user.id))
      }
    });
  } catch {
    await refundUsage(env, reservation);
    return json({ error: 'AI service temporarily unavailable' }, 502);
  }
}

async function route(request, env) {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/api/config') {
    return json({
      googleClientId: env.GOOGLE_CLIENT_ID,
      razorpayKeyId: env.RAZORPAY_KEY_ID,
      freeDailyLimit: FREE_LIMIT,
      topup: { amount: TOPUP_AMOUNT, requests: TOPUP_REQUESTS },
      subscription: { amount: SUBSCRIPTION_AMOUNT, requests: SUBSCRIPTION_REQUESTS, days: SUBSCRIPTION_DAYS }
    });
  }
  if (request.method === 'POST' && url.pathname === '/api/payments/webhook') {
    return handleWebhook(request, env);
  }

  let user;
  try {
    user = await authenticate(request, env);
  } catch (error) {
    return json({ error: error.message || 'Sign-in verification failed' }, 401);
  }
  if (!user) return json({ error: 'Sign in with Google to continue' }, 401);

  if (request.method === 'GET' && url.pathname === '/api/me') {
    return json({ account: await accountSummary(env, user.id) });
  }
  if (request.method === 'POST' && url.pathname === '/api/payments/order') {
    return createTopupOrder(request, env, user);
  }
  if (request.method === 'POST' && url.pathname === '/api/payments/subscription') {
    return createMonthlySubscription(env, user);
  }
  if (request.method === 'POST' && url.pathname === '/api/payments/verify-topup') {
    return verifyTopup(request, env, user);
  }
  if (request.method === 'POST' && url.pathname === '/api/payments/verify-subscription') {
    return verifySubscription(request, env, user);
  }
  if (request.method === 'POST' && url.pathname === '/api/payments/cancel-subscription') {
    return cancelSubscription(env, user);
  }
  if (request.method === 'POST' && url.pathname.startsWith('/v1beta/')) {
    return handleGemini(request, env, user, url);
  }
  return json({ error: 'Not found' }, 404);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const headers = corsHeaders(origin, env);
    if (origin && origin !== env.SITE_ORIGIN) return json({ error: 'Origin not allowed' }, 403);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    try {
      const response = await route(request, env);
      const responseHeaders = new Headers(response.headers);
      for (const [key, value] of Object.entries(headers)) responseHeaders.set(key, value);
      return new Response(response.body, { status: response.status, headers: responseHeaders });
    } catch (error) {
      return json({ error: error.message || 'Request failed' }, 500, headers);
    }
  }
};
