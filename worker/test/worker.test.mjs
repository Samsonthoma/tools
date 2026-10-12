import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import worker from '../src/index.mjs';
import { creditSubscription, creditTopup, hmacHex, refundUsage, reserveUsage } from '../src/index.mjs';

const env = {
  SITE_ORIGIN: 'https://tools.thesouthindianschool.in',
  GOOGLE_CLIENT_ID: 'test-client-id',
  RAZORPAY_KEY_ID: 'test-key-id'
};
let validGoogleToken;

class MemoryD1 {
  constructor() {
    this.dailyCount = 0;
    this.paidRequests = 0;
    this.subscriptionRequests = 0;
    this.subscriptionExpiresAt = null;
    this.subscriptionStatus = 'inactive';
    this.currentSubscriptionId = null;
    this.order = null;
    this.subscriptions = new Map();
    this.processedPayments = new Set();
    this.webhookEvents = new Set();
  }

  prepare(sql) {
    return {
      bind: (...values) => ({
        sql,
        values,
        first: async () => {
          if (sql.includes('UPDATE daily_usage SET request_count = request_count + 1')) {
            const limit = values[2];
            if (this.dailyCount >= limit) return null;
            this.dailyCount++;
            return { request_count: this.dailyCount };
          }
          if (sql.includes('UPDATE users SET subscription_requests = subscription_requests - 1')) {
            if (this.subscriptionRequests < 1 || !this.subscriptionExpiresAt ||
                Date.parse(`${this.subscriptionExpiresAt.replace(' ', 'T')}Z`) <= Date.now()) return null;
            this.subscriptionRequests--;
            return { subscription_requests: this.subscriptionRequests };
          }
          if (sql.includes('UPDATE users SET paid_requests = paid_requests - 1')) {
            if (this.paidRequests < 1) return null;
            this.paidRequests--;
            return { paid_requests: this.paidRequests };
          }
          if (sql.includes('FROM payment_orders')) return this.order;
          if (sql.includes('FROM subscriptions')) return this.subscriptions.get(values[0]) || null;
          if (sql.includes('FROM webhook_events')) {
            return this.webhookEvents.has(values[0]) ? { event_id: values[0] } : null;
          }
          if (sql.includes('SELECT request_count FROM daily_usage')) {
            return { request_count: this.dailyCount };
          }
          if (sql.includes('SELECT email, name, paid_requests')) {
            return {
              email: 'student@example.com',
              name: 'Student',
              paid_requests: this.paidRequests,
              subscription_requests: this.subscriptionRequests,
              subscription_expires_at: this.subscriptionExpiresAt,
              subscription_status: this.subscriptionStatus,
              current_subscription_id: this.currentSubscriptionId
            };
          }
          return null;
        },
        run: async () => {
          if (sql.includes('UPDATE daily_usage SET request_count = MAX')) this.dailyCount = Math.max(0, this.dailyCount - 1);
          if (sql.includes('UPDATE users SET subscription_requests = subscription_requests + 1')) this.subscriptionRequests++;
          if (sql.includes('UPDATE users SET paid_requests = paid_requests + 1')) this.paidRequests++;
          if (sql.includes('INSERT OR IGNORE INTO webhook_events')) this.webhookEvents.add(values[0]);
          return { meta: { changes: 1 } };
        }
      })
    };
  }

  async batch(statements) {
    let changes = 0;
    const results = [];
    for (const statement of statements) {
      const { sql, values } = statement;
      if (sql.includes('INSERT OR IGNORE INTO processed_payments')) {
        const paymentId = values[0];
        changes = this.processedPayments.has(paymentId) ? 0 : 1;
        this.processedPayments.add(paymentId);
      } else if (sql.includes('UPDATE payment_orders SET status')) {
        if (this.order?.status === 'created' && this.order.user_id === values[2] &&
            !this.processedPayments.has(values[3])) {
          this.order.status = 'paid';
          this.order.payment_id = values[0];
          changes = 1;
        } else {
          changes = 0;
        }
      } else if (sql.includes('INSERT INTO processed_payments')) {
        const subscriptionCharge = sql.includes('current_subscription_id');
        if (!this.processedPayments.has(values[0]) &&
            (subscriptionCharge
              ? this.currentSubscriptionId === values[3]
              : changes === 1)) {
          this.processedPayments.add(values[0]);
          changes = 1;
        } else {
          changes = 0;
        }
      } else if (sql.includes('UPDATE users SET paid_requests = paid_requests + ?')) {
        if (changes === 1) this.paidRequests += values[0];
        else changes = 0;
      } else if (sql.includes('UPDATE users SET subscription_requests = ?')) {
        if (changes === 1 && this.currentSubscriptionId === values[2]) {
          this.subscriptionRequests = values[0];
          this.subscriptionExpiresAt = new Date(Date.now() + 30 * 86400000)
            .toISOString().slice(0, 19).replace('T', ' ');
          if (this.subscriptionStatus !== 'cancelled') this.subscriptionStatus = 'active';
          changes = 1;
        } else {
          changes = 0;
        }
      } else if (sql.includes('UPDATE subscriptions SET status')) {
        if (changes !== 1) changes = 0;
      }
      results.push({ meta: { changes } });
    }
    return results;
  }
}

test('serves public checkout configuration to the site origin', async () => {
  const response = await worker.fetch(new Request('https://worker.example/api/config', {
    headers: { Origin: env.SITE_ORIGIN }
  }), env);
  const config = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), env.SITE_ORIGIN);
  assert.equal(config.googleClientId, env.GOOGLE_CLIENT_ID);
  assert.equal(config.razorpayKeyId, env.RAZORPAY_KEY_ID);
  assert.equal(config.freeDailyLimit, 7);
});

test('rejects requests from unapproved browser origins', async () => {
  const response = await worker.fetch(new Request('https://worker.example/api/config', {
    headers: { Origin: 'https://attacker.example' }
  }), env);

  assert.equal(response.status, 403);
});

test('preflights authorization requests from the configured site', async () => {
  const response = await worker.fetch(new Request('https://worker.example/api/me', {
    method: 'OPTIONS',
    headers: { Origin: env.SITE_ORIGIN }
  }), env);

  assert.equal(response.status, 204);
  assert.match(response.headers.get('Access-Control-Allow-Headers'), /Authorization/);
});

test('requires a Google ID token for account and AI endpoints', async () => {
  const response = await worker.fetch(new Request('https://worker.example/api/me', {
    headers: { Origin: env.SITE_ORIGIN }
  }), env);

  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, 'Sign in with Google to continue');
});

test('accepts a correctly signed Google ID token for the account endpoint', async () => {
  const originalFetch = globalThis.fetch;
  const keyPair = await crypto.subtle.generateKey({
    name: 'RSASSA-PKCS1-v1_5',
    modulusLength: 2048,
    publicExponent: Uint8Array.of(1, 0, 1),
    hash: 'SHA-256'
  }, true, ['sign', 'verify']);
  const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  publicJwk.kid = 'test-signing-key';
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';

  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'RS256', kid: publicJwk.kid });
  const claims = encode({
    iss: 'https://accounts.google.com',
    aud: env.GOOGLE_CLIENT_ID,
    sub: 'google-user-123',
    email: 'student@example.com',
    email_verified: true,
    name: 'Student',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600
  });
  const unsignedToken = `${header}.${claims}`;
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    keyPair.privateKey,
    new TextEncoder().encode(unsignedToken)
  );
  validGoogleToken = `${unsignedToken}.${Buffer.from(signature).toString('base64url')}`;
  globalThis.fetch = async () => new Response(JSON.stringify({ keys: [publicJwk] }));
  const database = {
    prepare(sql) {
      return {
        bind() {
          return {
            run: async () => ({ meta: { changes: 1 } }),
            first: async () => sql.includes('SELECT request_count')
              ? null
              : {
                email: 'student@example.com',
                name: 'Student',
                paid_requests: 0,
                subscription_requests: 0,
                subscription_expires_at: null,
                subscription_status: 'inactive',
                current_subscription_id: null
              }
          };
        }
      };
    }
  };
  try {
    const response = await worker.fetch(new Request('https://worker.example/api/me', {
      headers: {
        Origin: env.SITE_ORIGIN,
        Authorization: 'Bearer ' + validGoogleToken
      }
    }), { ...env, DB: database });
    const result = await response.json();

    assert.equal(response.status, 200);
    assert.equal(result.account.email, 'student@example.com');
    assert.equal(result.account.freeRemaining, 7);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('reserves at most seven free requests concurrently and refunds failed requests', async () => {
  const database = new MemoryD1();
  const quotaEnv = { DB: database, FREE_DAILY_LIMIT: '7' };
  const reservations = await Promise.all(
    Array.from({ length: 8 }, () => reserveUsage(quotaEnv, 'user-1'))
  );

  assert.equal(reservations.filter(Boolean).length, 7);
  assert.equal(database.dailyCount, 7);
  await refundUsage(quotaEnv, reservations.find(Boolean));
  assert.equal(database.dailyCount, 6);
  assert.ok(await reserveUsage(quotaEnv, 'user-1'));
  assert.equal(database.dailyCount, 7);
});

test('uses paid requests after the free quota and refunds failed paid calls', async () => {
  const database = new MemoryD1();
  database.dailyCount = 7;
  database.paidRequests = 2;
  const quotaEnv = { DB: database, FREE_DAILY_LIMIT: '7' };

  const reservation = await reserveUsage(quotaEnv, 'user-1');
  assert.equal(reservation.type, 'paid');
  assert.equal(database.paidRequests, 1);
  await refundUsage(quotaEnv, reservation);
  assert.equal(database.paidRequests, 2);
});

test('uses subscription requests before top-ups and refunds failed subscription calls', async () => {
  const database = new MemoryD1();
  database.dailyCount = 7;
  database.subscriptionRequests = 1;
  database.subscriptionExpiresAt = new Date(Date.now() + 30 * 86400000)
    .toISOString().slice(0, 19).replace('T', ' ');
  database.paidRequests = 10;
  const quotaEnv = { DB: database, FREE_DAILY_LIMIT: '7' };

  const reservation = await reserveUsage(quotaEnv, 'user-1');
  assert.equal(reservation.type, 'subscription');
  assert.equal(database.subscriptionRequests, 0);
  assert.equal(database.paidRequests, 10);
  await refundUsage(quotaEnv, reservation);
  assert.equal(database.subscriptionRequests, 1);
});

test('credits Razorpay top-ups once even when verification and webhook race', async () => {
  const database = new MemoryD1();
  database.order = { user_id: 'user-1', amount: 4900, status: 'created' };
  const payment = {
    id: 'pay-1',
    order_id: 'order-1',
    amount: 4900,
    currency: 'INR',
    status: 'captured'
  };

  assert.equal(await creditTopup({ DB: database }, 'order-1', payment), true);
  assert.equal(await creditTopup({ DB: database }, 'order-1', payment), false);
  assert.equal(database.paidRequests, 50);
  await creditTopup({ DB: database }, 'order-1', { ...payment, id: 'pay-another' });
  assert.equal(database.processedPayments.has('pay-another'), false);
  assert.equal(database.paidRequests, 50);
});

test('only credits the currently selected subscription', async () => {
  const database = new MemoryD1();
  database.currentSubscriptionId = 'sub-current';
  database.subscriptions.set('sub-current', { user_id: 'user-1' });
  database.subscriptions.set('sub-old', { user_id: 'user-1' });
  const payment = {
    id: 'pay-sub',
    subscription_id: 'sub-current',
    amount: 19900,
    currency: 'INR',
    status: 'captured'
  };

  assert.equal(await creditSubscription({ DB: database }, 'sub-current', payment), true);
  assert.equal(database.subscriptionRequests, 500);
  assert.equal(database.subscriptionStatus, 'active');
  assert.equal(await creditSubscription({ DB: database }, 'sub-old', {
    ...payment,
    id: 'pay-old',
    subscription_id: 'sub-old'
  }), false);
  assert.equal(database.subscriptionStatus, 'active');
});

test('a final subscription charge does not undo scheduled cancellation', async () => {
  const database = new MemoryD1();
  database.currentSubscriptionId = 'sub-cancelled';
  database.subscriptionStatus = 'cancelled';
  database.subscriptions.set('sub-cancelled', {
    user_id: 'user-1',
    subscription_id: 'sub-cancelled',
    status: 'cancelled'
  });
  const credited = await creditSubscription({ DB: database }, 'sub-cancelled', {
    id: 'pay-final-cycle',
    subscription_id: 'sub-cancelled',
    amount: 19900,
    currency: 'INR',
    status: 'captured'
  });

  assert.equal(credited, true);
  assert.equal(database.subscriptionRequests, 500);
  assert.equal(database.subscriptionStatus, 'cancelled');
});

test('acknowledges signed Razorpay webhooks with non-matching payment details', async () => {
  const database = new MemoryD1();
  database.order = { user_id: 'user-1', amount: 4900, status: 'created' };
  const payload = JSON.stringify({
    event: 'payment.captured',
    payload: {
      payment: {
        entity: {
          id: 'pay-wrong',
          order_id: 'order-1',
          amount: 100,
          currency: 'INR',
          status: 'captured'
        }
      }
    }
  });
  const secret = 'test-webhook-secret';
  const signature = createHmac('sha256', secret).update(payload).digest('hex');
  const response = await worker.fetch(new Request('https://worker.example/api/payments/webhook', {
    method: 'POST',
    headers: {
      'X-Razorpay-Signature': signature,
      'X-Razorpay-Event-Id': 'event-mismatch'
    },
    body: payload
  }), { ...env, DB: database, RAZORPAY_WEBHOOK_SECRET: secret });

  assert.equal(response.status, 200);
  assert.equal((await response.json()).ignored, true);
  assert.equal(database.paidRequests, 0);
  assert.ok(database.webhookEvents.has('event-mismatch'));
});

test('uses Razorpay HMAC-SHA256 signatures', async () => {
  const signature = await hmacHex('secret', 'order|payment');
  assert.equal(signature, createHmac('sha256', 'secret').update('order|payment').digest('hex'));
});

test('reports authorized Razorpay payments as pending without crediting them', async () => {
  const originalFetch = globalThis.fetch;
  const database = new MemoryD1();
  database.order = {
    order_id: 'order-pending',
    user_id: 'google-user-123',
    amount: 4900,
    status: 'created'
  };
  database.subscriptions.set('sub-pending', {
    subscription_id: 'sub-pending',
    user_id: 'google-user-123'
  });
  database.currentSubscriptionId = 'sub-pending';
  globalThis.fetch = async () => Response.json({
    id: 'payment-pending',
    order_id: 'order-pending',
    subscription_id: 'sub-pending',
    amount: 4900,
    currency: 'INR',
    status: 'authorized'
  });
  const workerEnv = {
    ...env,
    DB: database,
    RAZORPAY_KEY_SECRET: 'test-key-secret'
  };
  try {
    const topupSignature = await hmacHex('test-key-secret', 'order-pending|payment-pending');
    const topup = await worker.fetch(new Request('https://worker.example/api/payments/verify-topup', {
      method: 'POST',
      headers: {
        Origin: env.SITE_ORIGIN,
        Authorization: 'Bearer ' + validGoogleToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        orderId: 'order-pending',
        paymentId: 'payment-pending',
        signature: topupSignature
      })
    }), workerEnv);
    assert.equal(topup.status, 202);
    assert.equal((await topup.json()).paymentPending, true);
    assert.equal(database.paidRequests, 0);

    globalThis.fetch = async () => Response.json({
      id: 'payment-pending',
      subscription_id: 'sub-pending',
      amount: 19900,
      currency: 'INR',
      status: 'authorized'
    });
    const subscriptionSignature = await hmacHex('test-key-secret', 'payment-pending|sub-pending');
    const subscription = await worker.fetch(new Request('https://worker.example/api/payments/verify-subscription', {
      method: 'POST',
      headers: {
        Origin: env.SITE_ORIGIN,
        Authorization: 'Bearer ' + validGoogleToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        subscriptionId: 'sub-pending',
        paymentId: 'payment-pending',
        signature: subscriptionSignature
      })
    }), workerEnv);
    assert.equal(subscription.status, 202);
    assert.equal((await subscription.json()).paymentPending, true);
    assert.equal(database.subscriptionRequests, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('proxies Gemini with the Worker secret and refunds failed upstream requests', async () => {
  const originalFetch = globalThis.fetch;
  const database = new MemoryD1();
  const sentHeaders = [];
  let failUpstream = false;
  globalThis.fetch = async (url, options) => {
    assert.match(String(url), /^https:\/\/generativelanguage\.googleapis\.com\//);
    sentHeaders.push(new Headers(options.headers));
    return failUpstream
      ? new Response('provider error', { status: 503 })
      : Response.json({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] });
  };
  try {
    const makeRequest = () => new Request(
      `https://worker.example/v1beta/models/gemini-3-flash-preview:generateContent`,
      {
        method: 'POST',
        headers: {
          Origin: env.SITE_ORIGIN,
          Authorization: 'Bearer ' + validGoogleToken,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ contents: [{ parts: [{ text: 'test' }] }] })
      }
    );
    const workerEnv = { ...env, DB: database, GEMINI_API_KEY: 'server-only-test-key' };
    const success = await worker.fetch(makeRequest(), workerEnv);
    assert.equal(success.status, 200);
    assert.equal((await success.json()).candidates[0].content.parts[0].text, 'ok');
    assert.equal(sentHeaders[0].get('x-goog-api-key'), 'server-only-test-key');
    assert.equal(JSON.parse(success.headers.get('X-Quota-Status')).freeRemaining, 6);

    failUpstream = true;
    const failed = await worker.fetch(makeRequest(), workerEnv);
    assert.equal(failed.status, 503);
    assert.equal(database.dailyCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('rejects oversized streamed prompts before quota reservation', async () => {
  const database = new MemoryD1();
  const oversizedBody = new Uint8Array(1024 * 1024 + 1);
  const request = new Request(
    'https://worker.example/v1beta/models/gemini-3-flash-preview:generateContent',
    {
      method: 'POST',
      headers: {
        Origin: env.SITE_ORIGIN,
        Authorization: 'Bearer ' + validGoogleToken,
        'Content-Type': 'application/json'
      },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(oversizedBody);
          controller.close();
        }
      }),
      duplex: 'half'
    }
  );
  const response = await worker.fetch(request, { ...env, DB: database });

  assert.equal(response.status, 413);
  assert.equal(database.dailyCount, 0);
});
