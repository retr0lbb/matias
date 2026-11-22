# Payment and subscription modules: overview

An onboarding guide to `src/payment` and `src/subscription`. The design history, step by step, is in [`payment-asaas.md`](payment-asaas.md).

## The big picture

The app sells paid plans through **Asaas**, a Brazilian payment provider. Two modules share the work:

- **`src/payment`** talks to Asaas over HTTP and nothing else. It does not touch the database.
- **`src/subscription`** holds the business rules: who can subscribe, what gets saved, and what happens when Asaas tells us a charge was paid, refunded or is overdue.

`subscription` imports `payment`, never the other way around.

## `src/payment`: the Asaas client

`PaymentService` (`payment.service.ts`) has these public methods (`findSubscription` and `deactivateSubscription` are used by the cron jobs below):

| Method | What it does |
|---|---|
| `createCustomer` | Creates a customer on Asaas and returns it with its `cus_...` id. Asaas does not detect duplicates, so the caller must save and reuse that id. |
| `createSubscription` | Creates a recurring subscription on Asaas (`sub_...`). Asaas then generates one charge per cycle. |
| `updateSubscription` | Changes an existing Asaas subscription. Used to remove the promo discount once its cycles are over. |
| `deactivateSubscription` | Sets an Asaas subscription to `INACTIVE` (it stops charging but is not deleted). |
| `findSubscription` | Reads an Asaas subscription; returns `null` on 404 instead of throwing. |
| `listSubscriptionPayments` | Lists the charges (`pay_...`) of a subscription. The first one exists right after creation. |
| `isValidWebhookToken` | Checks the token Asaas sends on webhooks against `ASAAS_WEBHOOK_TOKEN`. If the variable is not set, every webhook is rejected. |

All requests go through one private helper that turns failures into HTTP errors:

- **No response or timeout (10s):** `503 "Payment provider unavailable"`.
- **Asaas says 400** (for example an invalid CPF): `400` with Asaas's own message.
- **Anything else:** `502 "Payment provider error"`.

Configuration comes from `.env`: `ASAAS_API_KEY` (required), `ASAAS_API_URL` (defaults to the sandbox) and `ASAAS_WEBHOOK_TOKEN`.

## `src/subscription`: the business rules

### The pieces

- **`subscription.controller.ts`** exposes `POST /subscription` (logged-in user with verified email) and `GET /subscription/plans` (public).
- **`subscription.service.ts`** (`SubscriptionService`) creates subscriptions and changes their status.
- **`webhooks/asaas-webhook.controller.ts`** exposes `POST /webhooks/asaas`, the public endpoint Asaas calls.
- **`payment-record.service.ts`** (`PaymentRecordService`) keeps the `payments` table in step with each charge.
- **`payment-record.ts` and `subscription-match.ts`** are small shared helpers: one maps an Asaas charge to a `payments` row, the other finds which local subscription an Asaas object belongs to.

### Subscription statuses

| Status | Meaning |
|---|---|
| `PENDING` | Created, waiting for the first payment. |
| `ACTIVE` | Paid; the user has the plan. |
| `EXPIRED` | **Past due**, not ended. A payment is late but the subscription is still live and the user keeps the plan. |
| `INACTIVE` | Ended (refund, chargeback or cancellation). The only "dead" state. |

A user can have only one live subscription (`PENDING`, `ACTIVE` or `EXPIRED`) at a time; the database enforces this.

### Flow 1: the user subscribes

`POST /subscription` with `planId`, `paymentMethod` (`PIX` or `CREDIT_CARD`), `fullName`, `cpf` and an optional `discountCode`:

1. Check the user, the plan and that there is no existing subscription to that plan.
2. In one transaction, save the subscription as `PENDING` and, if a discount code was sent, validate it and record its use.
3. Find or create the Asaas customer, reusing the `cus_...` id from an earlier subscription if there is one.
4. Create the subscription on Asaas, sending our local subscription id as `externalReference`. That is how webhooks are later tied back to our row. With a discount code, the `value` is still the full plan price and the code goes in the Asaas `discount` object.
5. Read the first charge, store it in `payments` as `PENDING`, and return its `paymentUrl` (the Asaas page where the user pays) plus `originalPrice`, `discountedPrice` and `discountedCycles` (cents; the last two are `null` without a code).

A discount code is rejected (`400`) when it is not valid, has not started, has expired, reached its limits, or would bring the price below R$ 5,00 (the Asaas minimum). Details in [`promo-code-discount.md`](promo-code-discount.md).

If step 3 or 4 fails, the local rows are deleted so the user can try again.

Nothing is activated here. The user only gets the plan when Asaas confirms the payment.

### Flow 2: Asaas calls the webhook

Every call to `POST /webhooks/asaas` is first checked for the `asaas-access-token` header; a wrong token gets `401`. A body we cannot read is acknowledged with `200` and ignored, because Asaas pauses the queue after repeated errors.

Then the event decides what happens to the **subscription**:

| Event | Effect |
|---|---|
| `PAYMENT_CONFIRMED`, `PAYMENT_RECEIVED` | `PENDING` → `ACTIVE` and the user moves to the plan. If it was `EXPIRED`, it goes back to `ACTIVE`. |
| `PAYMENT_OVERDUE` | `ACTIVE` → `EXPIRED`; the user keeps the plan. |
| `PAYMENT_REFUNDED`, `PAYMENT_CHARGEBACK_REQUESTED`, `SUBSCRIPTION_INACTIVATED`, `SUBSCRIPTION_DELETED` | → `INACTIVE` and the user goes back to `FREE`. |
| `PAYMENT_DELETED`, `PAYMENT_CREDIT_CARD_CAPTURE_REFUSED` | Warning in the log only. |
| Anything else | Acknowledged and ignored. |

Finally, if the event carries a charge, `PaymentRecordService` updates the **`payments`** table:

| Event | Charge status |
|---|---|
| `PAYMENT_CREATED` | `PENDING` (this is how recurring charges get stored) |
| `PAYMENT_CONFIRMED`, `PAYMENT_RECEIVED` | `PAID`, with `paid_at` |
| `PAYMENT_OVERDUE` | `OVERDUE` |
| `PAYMENT_REFUNDED`, `PAYMENT_CHARGEBACK_REQUESTED` | `REFUNDED` |
| `PAYMENT_DELETED`, `PAYMENT_CREDIT_CARD_CAPTURE_REFUSED` | `FAILED` |

The events also move the **promo redemption** of the subscription: the first payment turns it from `PENDING` into `APPLIED`, and an event that ends the subscription turns it into `REVOKED` (it stops counting toward the limits of the code). After each paid event, once as many charges are `PAID` as the code has discounted cycles, the discount is removed from the Asaas subscription and `discount_removed_at` is set, so later charges are the full price.

Asaas can deliver the same event twice or out of order, so every step is safe to repeat: activating twice does nothing the second time, and a charge never moves "backwards" (a refunded charge is not marked paid again).

## Cron jobs (`src/shared/crons`)

Two scheduled jobs (`@nestjs/schedule`, `America/Sao_Paulo`) cover what the webhook misses. Each skips a tick while its previous run is still going, and a failure on one subscription is logged and retried on the next run.

**Count Olaf** (`cont_olaf/`, every 30 min) syncs live local subscriptions (`PENDING`, `ACTIVE`, `EXPIRED`) with Asaas:

| Situation | Effect |
|---|---|
| `PENDING` with no `asaas_subscription_id`, older than 1h | → `INACTIVE` (`OLAF_NOT_ON_ASAAS`) |
| Asaas answers 404 or `deleted: true` | → `INACTIVE` (`OLAF_NOT_ON_ASAAS`) |
| Asaas status `INACTIVE` / `EXPIRED` | → `INACTIVE` (`OLAF_ASAAS_<STATUS>`) |
| Asaas `ACTIVE` | Every charge is upserted into `payments` through `PaymentRecordService` (same forward-only rules as the webhook). If a charge is paid: a local `PENDING` is activated, then the promo discount is checked. |

**Mr Beliarge** (`mr_beliarge/`, daily 03:00) ends `ACTIVE`/`EXPIRED` subscriptions whose oldest `OVERDUE` charge is due more than 3 days ago (`GRACE_DAYS`): the Asaas subscription is set to `INACTIVE` (not deleted), then the local one goes `INACTIVE` (`BELIARGE_OVERDUE_GRACE_EXPIRED`). If Asaas fails, the local row is left for the next run.

## Things a newcomer should know

- **Money units:** Asaas works in reais (`29.9`); our database stores cents (`2990`) in both `plans.price` and `payments.value`.
- **Three Asaas ids:** `cus_...` (customer), `sub_...` (subscription) and `pay_...` (one charge). We store all three.
- **Local testing needs a tunnel** (ngrok) so Asaas can reach the webhook, and the webhook must be subscribed to the events above in the Asaas panel.
- **`GAP` tests:** some specs contain tests marked `GAP` that fail on purpose; they describe known bugs not yet fixed (mostly in `createSubscription`).
- **Known open items (as of 2026-11-16):**
  - The promo discount is an Asaas early-payment discount: a charge paid after its due date is the full price, and the first charge is due the day the user subscribes.
  - `payments.value` keeps the value the charge was created with, not the discounted amount paid.
  - A refund does not cancel the subscription on Asaas.
  - Orphan subscriptions created on Asaas but lost locally are not handled; Count Olaf only covers the reverse (local rows missing on Asaas).
