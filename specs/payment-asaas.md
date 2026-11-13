# Asaas payment module: `createCustomer`

## Context

The app is getting paid subscriptions through Asaas. `src/payment/payment.service.ts` is an empty scaffold (`createCustomer() {}`, `createSubscription() {}`), and `SubscriptionService.createSubscription` ends with a dead, unsent Asaas request with `customer: ""`. An Asaas subscription needs a customer id (`cus_...`), so the first step is a working `PaymentService.createCustomer`. Only that method is implemented now; `createSubscription` stays a stub.

Decisions confirmed with the user:
- `cpfCnpj` comes in as a **method parameter** (the `users` table has no such column; no DB changes now).
- `payment.service.spec.ts` is **not touched**. It will fail once `ConfigService` is injected (no provider in its testing module) — known and accepted.

## Asaas facts (from docs.asaas.com)

- Base URL: sandbox `https://api-sandbox.asaas.com/v3`, production `https://api.asaas.com/v3`.
- Headers: `access_token: <api key>`, `Content-Type: application/json`, `User-Agent: <app name>` (mandatory for newer accounts).
- Keys: sandbox `$aact_hmlg_...`, production `$aact_prod_...`; a key used against the wrong environment returns 401.
- `POST /v3/customers`: required `name`, `cpfCnpj`; optional `email`, `mobilePhone`, `externalReference`, `notificationDisabled`, address fields, etc.
- 200 response: `{ object: "customer", id: "cus_...", dateCreated, name, email, cpfCnpj, personType, externalReference, notificationDisabled, deleted, ... }`.
- Errors (400/401): `{ errors: [{ code, description }] }`. 429 on rate limit.
- **Asaas does not dedupe customers** — calling twice with the same CPF creates two. The caller must persist the returned id and reuse it (out of scope here; noted for the subscription step).

## Changes

### 0. `specs/payment-asaas.md` (new)
Copy this plan there before coding (standing project convention).

### 1. `src/payment/dto/asaas-customer.dto.ts` (new)
Plain types, no zod (the method is internal, not a request body yet):
- `CreateAsaasCustomerInput`: `name: string`, `cpfCnpj: string`, optional `email`, `mobilePhone`, `externalReference`, `notificationDisabled`.
- `AsaasCustomer`: response shape (`id`, `name`, `cpfCnpj`, `email`, `externalReference`, `personType: "FISICA" | "JURIDICA"`, `dateCreated`, `deleted`, `notificationDisabled`; nullable where Asaas may omit).
- `AsaasErrorResponse`: `{ errors: { code: string; description: string }[] }`.

### 2. `src/payment/payment.service.ts`
- Inject `ConfigService` (global, see `src/app.module.ts`), same pattern as `src/rag/embedding.service.ts`: read in constructor
  - `ASAAS_API_KEY` via `getOrThrow`
  - `ASAAS_API_URL` via `get`, default `https://api-sandbox.asaas.com/v3`
- `private readonly logger = new Logger(PaymentService.name)`.
- Private helper `request<T>(method, path, body?)` — reused later by `createSubscription`:
  - native `fetch` (Node 24; no new dependency), headers `access_token`, `Content-Type`, `accept`, `User-Agent: "MATIAS/1.0.0"` (value already used in `subscription.service.ts`), `signal: AbortSignal.timeout(10_000)`.
  - `fetch` throws (network/timeout) → log, throw `ServiceUnavailableException("Payment provider unavailable")`.
  - `400` → `BadRequestException` with the joined Asaas `errors[].description` (e.g. invalid CPF).
  - any other non-2xx (401, 429, 5xx) → log status + error codes (never the key), throw `BadGatewayException("Payment provider error")`.
  - ok → parsed JSON as `T`.
- `async createCustomer(input: CreateAsaasCustomerInput): Promise<AsaasCustomer>`:
  - strip non-digits from `cpfCnpj` before sending
  - `return this.request<AsaasCustomer>("POST", "/customers", { ...input, cpfCnpj })`
- `createSubscription()` left as the empty stub.

### 3. `src/payment/payment.module.ts`
Add `exports: [PaymentService]` so `SubscriptionModule` can import it in the next step.

### 4. `.env.example`
Add:
```
# Asaas (sandbox key starts with $aact_hmlg_; wrap in single quotes because of the $)
ASAAS_API_KEY='YOUR_ASAAS_API_KEY'
ASAAS_API_URL=https://api-sandbox.asaas.com/v3
```

### Not touched
- `src/payment/payment.service.spec.ts` (per user; will fail on DI of `ConfigService`).
- `src/subscription/*` — wiring `createCustomer` into the subscribe flow, where `cpfCnpj` is collected, and where the `cus_...` id is stored are the next step.
- DB schemas.

## Verification

- `npx tsc --noEmit` — expect no new errors (the 3 known stale-fixture errors in auth specs may remain).
- `npm run lint`.
- `npm test` is **not** run (auth specs known broken; payment spec expected to fail by decision).
- Manual sandbox check (needs a real `ASAAS_API_KEY` sandbox key in `.env`): run a throwaway script from the scratchpad that calls `POST {ASAAS_API_URL}/customers` through the service (or `curl` with the same headers) using a valid test CPF, and confirm a `cus_...` id comes back; repeat with an invalid CPF to confirm the 400 → `BadRequestException` message. If no sandbox key is available, this step is reported as not done.

---

# Step 2: wire Asaas into `SubscriptionService.createSubscription`

## Flow
1. Validate promo code, plan and "already subscribed" (existing logic). The plan's `billing_interval` is mapped to an Asaas `cycle` here, before anything is written.
2. Insert the local subscription as `PENDING` (+ `PENDING` promo redemption) — the "intent".
3. Resolve the Asaas customer: reuse the `customerId` of any other subscription of the user, otherwise `PaymentService.createCustomer` (`fullName`, `cpf` from the body, user email, `externalReference` = user id).
4. Save `customerId` on the local subscription.
5. `PaymentService.createSubscription` on Asaas: `billingType: "UNDEFINED"` (payer picks PIX/boleto/card on the Asaas invoice), `value` = `plan.price / 100` (price is stored in cents), `nextDueDate` = today, `externalReference` = local subscription id.
6. If step 3–5 fails, the local redemption and subscription rows are deleted so the user can retry, and the error is rethrown.

## Changes
- `src/subscription/dto/create-subscription.dto.ts`: add `fullName`, `cpf` (temporary, until they live on the user).
- `src/payment/dto/asaas-subscription.dto.ts` (new) + `PaymentService.createSubscription`.
- `src/subscription/subscription.module.ts`: import `PaymentModule`.
- `src/subscription/subscription.service.ts`: the flow above.

## Not done here
- No column for the Asaas subscription id (`sub_...`); correlation is via `externalReference`. Needs a schema change + migration.
- Promo codes are recorded locally but not applied to the Asaas value.
- Webhooks (PENDING → ACTIVE) and returning the invoice URL to the client.
- Spec files are untouched.

---

# Step 3: payment method + Asaas webhook

- Body gets `paymentMethod`: `CREDIT_CARD` | `PIX`, sent as the Asaas `billingType`. Verified in the sandbox: both work without card data, the first charge exists right after creation, and the charge inherits the subscription's `externalReference` (our local subscription id).
- `POST /subscription` now returns `paymentUrl` (the first charge's `invoiceUrl`, read with `PaymentService.listSubscriptionPayments`).
- `POST /webhooks/asaas` (`src/subscription/asaas-webhook.controller.ts`, public): checks the `asaas-access-token` header against `ASAAS_WEBHOOK_TOKEN`; on `PAYMENT_CONFIRMED` / `PAYMENT_RECEIVED` calls `SubscriptionService.activateFromPayment`, which flips the local subscription `PENDING` -> `ACTIVE` and sets `users.plan` + `cycleAnchorAt` in one transaction. Everything else is acknowledged with 200.
- "Recurrent PIX" = a PIX charge generated every cycle. Pix Automático (bank-authorized auto debit) is a separate Asaas API and is not used.

Not done: refunds/chargebacks/overdue/cancellation events, promo redemption status, registering the webhook on Asaas (needs a public HTTPS URL).

---

# Step 4: webhook gaps (payment without id, missing reference, money going back)

1. **Payment without `id`**: `payment.id` becomes optional in `asaasWebhookSchema`; the id is only used for logging.
2. **Missing/foreign `externalReference`**: the webhook also sends the Asaas subscription id (`payment.subscription`, or `subscription.id` on `SUBSCRIPTION_*` events). The service matches by local id when the reference is one of our UUIDs, otherwise by `subscriptions.asaas_subscription_id`.
3. **Events that used to be dropped**:
   - `PAYMENT_OVERDUE` -> `SubscriptionService.markPastDue`: `ACTIVE` -> `EXPIRED` (past due, still live, user keeps the plan). A later `PAYMENT_CONFIRMED`/`PAYMENT_RECEIVED` moves `EXPIRED` back to `ACTIVE` without touching the user.
   - `PAYMENT_REFUNDED`, `PAYMENT_CHARGEBACK_REQUESTED`, `SUBSCRIPTION_INACTIVATED`, `SUBSCRIPTION_DELETED` -> `SubscriptionService.deactivate`: any live status -> `INACTIVE` (+ `cancelledAt`, `cancelReason` = event name) and `users.plan` -> `FREE`, in one transaction.
   - `PAYMENT_DELETED`, `PAYMENT_CREDIT_CARD_CAPTURE_REFUSED`: logged as a warning only. A deleted charge does not end a subscription, and a refused card turns into `PAYMENT_OVERDUE` if it stays unpaid.

Not done: cancelling the subscription on Asaas after a refund/chargeback, orphan subscriptions, promo redemption status, tests for the new service methods.
