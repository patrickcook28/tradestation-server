# Billing: $10/month with 14-day free trial

## Overview

- **Trial**: 14-day free trial (no charge until trial ends).
- **After trial**: $10/month (or annual plan if configured).
- Stripe Checkout collects payment method at signup; first charge is after the trial.

## Environment variables (Stripe)

Set these in your server `.env`:

| Variable | Description |
|----------|-------------|
| `STRIPE_SECRET_KEY` | Stripe secret key (live or test). |
| `STRIPE_PRICE_ID_MONTHLY` | **Required.** Stripe Price ID for the $10/month recurring product. |
| `STRIPE_PRICE_ID_ANNUAL` | Optional. Stripe Price ID for annual plan (used for “Subscribe Now” annual). |
| `STRIPE_PRICE_ID_TRIAL` | Optional. Leave unset so the server uses the monthly/annual price with `trial_period_days: 14`. Only set if you want a different Stripe price for trial signups. |
| `STRIPE_WEBHOOK_SECRET` | Webhook signing secret for subscription events. |

## Setting up products in Stripe (no separate trial product)

You do **not** need a separate “trial” product or price in Stripe. Both Monthly and Annual plans use the same price IDs; the server adds a 14-day trial when creating the Checkout session.

1. **Monthly**: In Stripe Dashboard → **Products** → create a product (e.g. “PrecisionTrader Monthly”). Add a **Price**: $10/month, recurring. Copy the **Price ID** → `STRIPE_PRICE_ID_MONTHLY`.
2. **Annual**: Same product or a second product. Add a **Price**: $100/year, recurring. Copy the **Price ID** → `STRIPE_PRICE_ID_ANNUAL`.
3. **Trial**: Nothing else. When the frontend sends `isTrial: true`, the backend uses the same monthly or annual price and sets `subscription_data.trial_period_days = 14` on the Checkout session. Stripe will not charge until after the 14-day trial.

Do **not** set `STRIPE_PRICE_ID_TRIAL` unless you want a different price for trial signups; leaving it unset uses the monthly/annual price with a trial.

## Flow (backend)

- `POST /billing/create_checkout_session` with `{ plan: 'monthly', isTrial: true }` creates a Checkout session with a 14-day trial.
- Trial reuse is blocked via `hasUsedTrial()` in `utils/subscriptionHelpers.js`.
- Webhooks in `utils/stripeWebhookHandler.js` sync subscription status; `routes/billing.js` exports the handlers.

## Frontend flow

1. User hits “Start 14-Day Free Trial” on landing or pricing → `/pricing`.
2. If not logged in, “Start Free Trial” → `/register?redirect=/pricing` (and `registration_redirect` in sessionStorage).
3. After register → verify email → redirect to `/login?redirect=/pricing`.
4. After login → redirect to `/pricing` → user clicks “Start Free Trial” → Stripe Checkout (trial).
5. Success → `/subscription-success` → redirect to `/trade`.
