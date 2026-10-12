# StudyCraft AI Worker

This Worker proxies Gemini requests, validates Google Identity Services ID tokens, enforces the per-account quota in D1, and handles Razorpay top-ups and recurring subscriptions. The browser never receives the Gemini API key.

## Deploy

The Worker is named `tools`, matching the API endpoint `https://tools.samsonthomasminithomas.workers.dev` used by the frontend. The allowed browser site origin is `https://tools.thesouthindianschool.in`.

1. In Cloudflare, create the D1 database named `tools-ai-db` (or use an existing database), then copy its database ID into `wrangler.toml`.
2. From this directory, apply the schema and deploy:

   ```sh
   npx wrangler d1 migrations apply tools-ai-db --remote
   npx wrangler deploy
   ```

3. Configure the Worker secrets in Cloudflare. Do not commit their values:

   ```sh
   npx wrangler secret put GEMINI_API_KEY
   npx wrangler secret put RAZORPAY_KEY_SECRET
   npx wrangler secret put RAZORPAY_WEBHOOK_SECRET
   ```

   Set `RAZORPAY_KEY_ID` as a Worker variable in Cloudflare (it is a public checkout identifier; keeping it as a secret also works). `keep_vars = true` in `wrangler.toml` preserves dashboard variables not listed in the file when deploying. The Google client ID, allowed site origin, and free daily request limit are non-secret Worker variables in `wrangler.toml`. The Google OAuth client must allow `https://tools.thesouthindianschool.in`.

4. In Razorpay, configure a webhook pointing to:

   ```
   https://tools.samsonthomasminithomas.workers.dev/api/payments/webhook
   ```

   Use the same webhook secret as `RAZORPAY_WEBHOOK_SECRET` and subscribe to `payment.captured`, `subscription.charged`, `subscription.cancelled`, `subscription.halted`, and `subscription.completed`.

Wrangler deployment is separate from the static-site deployment. Creating the D1 database and setting the secrets/variables in Cloudflare is required before the Worker can serve authenticated requests. The Worker creates the ₹199 monthly Razorpay plan on first use; each successfully captured monthly charge grants 500 requests for 30 days. Subscription checkout is recurring and users can cancel renewal from their account.

CORS only controls which browser origins can read responses; it is not authentication or an access-control boundary. The Worker independently verifies each Google ID token before accessing account, quota, payment, or Gemini endpoints.

## Quota behavior

Each verified Google account receives 7 free requests per calendar day in India Standard Time. Free requests are used first; when exhausted, active subscription requests and then top-up requests are used. A reserved request is refunded if the Gemini call fails. D1 serializes the conditional quota updates so concurrent requests cannot exceed a balance.

## Local checks

```sh
node --check src/index.mjs
node --test
```
