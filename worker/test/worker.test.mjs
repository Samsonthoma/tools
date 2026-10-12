import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.mjs';

const env = {
  SITE_ORIGIN: 'https://tools.thesouthindianschool.in',
  GOOGLE_CLIENT_ID: 'test-client-id',
  RAZORPAY_KEY_ID: 'test-key-id'
};

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
  const token = `${unsignedToken}.${Buffer.from(signature).toString('base64url')}`;
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
        Authorization: 'Bearer ' + token
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
