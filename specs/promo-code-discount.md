# Promo code discount on Asaas

## Context

`POST /subscription` already validates a `discountCode` and records a `promo_code_redemption` row, but Asaas is still charged the full plan price, and the redemption never leaves `PENDING`. This plan first closes the promo gaps the spec already describes (Phase A), then applies the discount on Asaas (Phase B).

Decisions confirmed with the user:
- **Mechanism:** the subscription `value` stays the full plan price; the promo is sent in Asaas's native `discount` object. After the Nth discounted charge is paid (`durationInCicle`), the discount is removed from the Asaas subscription.
- **Units:** `PERCENTAGE` is a whole number (10 = 10%); `FIXED` is in cents. The discounted price is floored to the cent.
- **Low price:** a code that brings the price below R$5.00 (Asaas minimum charge), to zero or negative is rejected with 400, before anything is written.
- **Gaps first:** `startsAt` check, redemption `APPLIED` on payment, `REVOKED` on refund/cancel; prices in the response.
- **Tests:** only `subscription.service.spec.ts` is updated (plus the one mock line the controller spec needs, see B6). No full `npm test` (auth specs are broken).

## Step 0

Copy this plan to `specs/promo-code-discount.md` before coding (project convention).

## Phase A: promo gaps (`src/subscription/subscription.service.ts`)

1. **`startsAt`** — in the `createSubscription` transaction, next to the `endsAt` check: `startsAt > now` → `BadRequestException("Discount code is not active yet")`.
2. **`APPLIED` on payment** — in `activateFromPayment`, inside the existing transaction after the subscription is activated: update `promoCodeRedemptions` set `status: "APPLIED"`, `redeemedAt: now` where `subscriptionId = activated.id` and `status = "PENDING"`.
3. **`REVOKED` on end** — in `deactivate`, inside the existing transaction: set `status: "REVOKED"` where `subscriptionId = ended.id` and status in (`PENDING`, `APPLIED`). A revoked redemption stops counting toward the global/user limits (they count only `PENDING`/`APPLIED`), so the user may use the code again.

Spec: un-GAP "should throw BadRequestException when the code has not started yet" and "should mark the promo redemption of the subscription as APPLIED"; add tests for the `REVOKED` update and for activation with no redemption.

## Phase B: discount on Asaas

### B1. `src/subscription/promo-discount.ts` (new, pure — like `payment-record.ts`)
- `discountedPrice(priceCents, type, value): number` — `PERCENTAGE`: `Math.floor(price * (100 - value) / 100)`; `FIXED`: `price - value`.
- `toAsaasDiscount(type, value): AsaasDiscount` — `PERCENTAGE` → `{ type, value, dueDateLimitDays: 0 }`; `FIXED` → value in reais (`value / 100`).
- `MIN_CHARGE_CENTS = 500`.

### B2. `src/payment/dto/asaas-subscription.dto.ts`
- `AsaasDiscount { value: number; dueDateLimitDays: number; type: "FIXED" | "PERCENTAGE" }`.
- `CreateAsaasSubscriptionInput.discount?: AsaasDiscount`.
- `UpdateAsaasSubscriptionInput { discount?: AsaasDiscount; updatePendingPayments?: boolean }`.

### B3. `src/payment/payment.service.ts`
- `updateSubscription(id, input)` → `PUT /subscriptions/{id}`; `request()` method union gains `"PUT"`. No spec changes for `PaymentService`.

### B4. Schema + migration
- `src/db/schemas/promo-code-redemptions.ts`: new nullable `discountRemovedAt: timestamp("discount_removed_at")` — marks that the discount was already removed on Asaas, so the removal runs once.
- `npm run db:generate` (migration is generated, not hand-written).

### B5. `SubscriptionService.createSubscription`
- In the transaction, after the existing coupon checks: reject a coupon with null `discountType` (`"Discount code is invalid"`), compute `discountedPrice(plann.price, …)`, and throw `BadRequestException("Discount code cannot be applied to this plan")` when it is `< MIN_CHARGE_CENTS`. The transaction rolls back, so nothing is written.
- Asaas call: `value` unchanged (`plann.price / 100`); add `discount: toAsaasDiscount(...)` when there is a coupon.
- Response gains `originalPrice`, `discountedPrice`, `discountedCycles` (cents; the last two `null` without a code).

### B6. Remove the discount after N cycles
- New `SubscriptionService.endDiscountIfExhausted(externalReference, asaasSubscriptionId): Promise<boolean>`:
  1. `matchSubscription` (reuse `subscription-match.ts`) → local subscription with an `asaasSubscriptionId`.
  2. Its redemption with `status = "APPLIED"` and `discountRemovedAt IS NULL`; none → `false`.
  3. Count `payments` rows of the subscription with `status = "PAID"` (one row per charge, so the card's CONFIRMED + RECEIVED pair counts once). `< durationInCicle` → `false`.
  4. `paymentService.updateSubscription(sub, { discount: { value: 0, dueDateLimitDays: 0, type }, updatePendingPayments: true })`, then set `discountRemovedAt = now`.
  - An Asaas failure propagates: the webhook answers non-200 and Asaas redelivers, same as the existing `recordFromWebhook` comment relies on. Every earlier step of the handler is already idempotent.
- `webhooks/asaas-webhook.controller.ts`: on `PAID_EVENTS`, call it **after** `recordFromWebhook` (the count needs the charge already marked `PAID`).
- `webhooks/asaas-webhook.controller.spec.ts`: the `subscriptionService` mock needs `endDiscountIfExhausted` added (one line + default `mockResolvedValue(false)`), otherwise every paid-event test breaks. Nothing else in that spec changes.

### B7. `subscription.service.spec.ts`
- Rewrite the GAP test "should charge the discounted value…": expects `value: 29.9` plus `discount: { type: "PERCENTAGE", value: 10, dueDateLimitDays: 0 }`.
- New: FIXED code sent in reais; no `discount` key without a code; rejection below R$5.00 / at zero / negative with no rows written; null `discountType`; response prices; `endDiscountIfExhausted` (no match, no redemption, already removed, fewer than N paid, exactly N paid → Asaas call + marker, Asaas failure leaves the marker unset).

### B8. Docs
Update the "Known open items" and Flow 1/Flow 2 in `specs/payment-subscription-overview.md`.

## Known caveats (to confirm in the sandbox, not solved here)

- **Native discount is an early-payment discount.** With `dueDateLimitDays: 0` it is only granted if the charge is paid by its due date. The first charge is due the day of the subscription, so a PIX paid the next day is charged full price. A late-paid cycle still counts as one of the N cycles.
- **`payments.value`** is stored from the charge's `value` when it is created (full price) and `recordFromWebhook` never updates it. Check what the paid webhook sends (`value` vs `originalValue`/`netValue`); if the paid amount differs, updating it is a follow-up in `PaymentRecordService` (its spec is out of scope here).
- **Asaas computes the percentage itself**, so the charged amount may differ by a cent from our floored `discountedPrice` in the response.
- `PUT /subscriptions/{id}` with `discount.value: 0` as "remove discount" must be confirmed against the sandbox.

## Verification

- `npx vitest run src/subscription/subscription.service.spec.ts` and `npx vitest run src/subscription/webhooks/asaas-webhook.controller.spec.ts` (remaining unrelated GAP tests keep failing by design).
- `npx tsc --noEmit`, `npm run lint`. No `npm test`.
- `npm run db:generate` then `npm run db:migrate` on the dev database.
- Sandbox (ngrok + sandbox key): subscribe with a 10% / 1-cycle code → invoice shows the discount; pay it → redemption `APPLIED`, Asaas subscription has no discount afterwards, `discount_removed_at` set; next charge is full price. Repeat with a 100% code → 400 and no rows. Refund → redemption `REVOKED`.
