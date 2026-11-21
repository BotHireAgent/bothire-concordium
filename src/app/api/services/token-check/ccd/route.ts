import { NextRequest, NextResponse } from 'next/server';
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from '@x402/core/http';
import { authenticateBot } from '@/lib/api-auth';
import { findOne, getCollection } from '@/lib/db';
import { rateLimit } from '@/lib/rate-limit';
import { isWalletProven } from '@/lib/agent-id';
import { buildTokenCheck, TokenDataUnavailable, UnknownToken } from '@/lib/token-check';
import { concordiumNetwork, concordiumStatusFor } from '@/lib/concordium';
import {
  ccdNextNonce, ccdRequirements, ccdTxFound, ccdTxSucceeded, concordiumPayEnabled, paymentHeader, CCD_MICRO, explorerTxUrl, paymentId, paymentSender, sameAccount, settleCcdPayment,
} from '@/lib/concordium-pay';
import type { TokenCheck } from '@/lib/token-check';

// Unpaid probes and paid calls for the same token share one build (60 s), so a 402 probe costs little.
const checkCache = new Map<string, { at: number; check: TokenCheck }>();
const checkBuilding = new Map<string, Promise<TokenCheck>>();
function getCheck(token: string): Promise<TokenCheck> {
  const hit = checkCache.get(token);
  if (hit && Date.now() - hit.at < 60_000) return Promise.resolve(hit.check);
  let p = checkBuilding.get(token);
  if (!p) {
    p = buildTokenCheck(token)
      .then((check) => {
        if (checkCache.size >= 500) checkCache.clear();
        checkCache.set(token, { at: Date.now(), check });
        return check;
      })
      .finally(() => checkBuilding.delete(token));
    checkBuilding.set(token, p);
  }
  return p;
}

// Per paying agent: at most 10 SUBMITTED payments per 10 minutes (each costs the sponsor a fee);
// refusals before submission don't count.
const attempts = new Map<string, number[]>();
function recentAttempts(botId: string): number[] {
  const now = Date.now();
  const list = (attempts.get(botId) || []).filter((t) => now - t < 10 * 60_000);
  attempts.set(botId, list);
  return list;
}
function recordAttempt(botId: string) {
  if (attempts.size > 5000) attempts.clear();
  recentAttempts(botId).push(Date.now());
}

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const PRICE_MICRO = Math.max(1, Math.floor(Number(process.env.CCD_TOKEN_CHECK_PRICE_MICRO || CCD_MICRO))); // default 1 CCD
const URL_SELF = 'https://www.bothire.io/api/services/token-check/ccd';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => NextResponse.json(body, { status, headers });
/** An error before any payment was submitted. */
const refuse = (status: number, error: string, message: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  json({ error, message, charged: false, ...extra }, status, headers);

const payments = () => getCollection('ccd_payments');

/**
 * POST /api/services/token-check/ccd   (Authorization: Bearer bh_… of the paying agent)
 * Body: { "token": "0x…" }   (a token contract on BNB Chain)
 *
 * Token Check for verified agents, paid with x402 on Concordium: both sides must be Verified by
 * Concordium (the provider also wallet-bound), the payment must come from the buyer's own verified
 * Concordium account, and BotHire sponsors the transaction fee. Without a PAYMENT-SIGNATURE header the
 * answer is 402 with the payment requirements; unknown tokens are refused before any payment.
 * One signed payment buys one check: resending the same PAYMENT-SIGNATURE returns the same result.
 */
export async function POST(request: NextRequest) {
  const hasSig = !!(request.headers.get('payment-signature') || request.headers.get('x-payment'));
  try {
    return await handle(request);
  } catch (e) {
    console.error('[token-check/ccd] unhandled', e);
    return json(
      {
        error: 'internal_error',
        message: hasSig
          ? 'Something went wrong on our side. Do not pay again: resend the same request with the same PAYMENT-SIGNATURE.'
          : 'Something went wrong on our side; try again shortly.',
        charged: hasSig ? 'unknown' : false,
        retryable: true,
      },
      500,
      { 'Retry-After': '15' },
    );
  }
}

/** 402 with fresh payment requirements (body + PAYMENT-REQUIRED header), so x402 clients can act on it. */
function paymentRequired(code: string, message: string, req: any, extra: Record<string, unknown> = {}) {
  const resource = { url: URL_SELF, description: 'BotHire Meme Desk Token Check', mimeType: 'application/json' };
  const required = { x402Version: 2, error: code, resource, accepts: [req] };
  return json({ ...required, message, charged: false, ...extra }, 402, { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(required as any), 'Cache-Control': 'no-store' });
}

async function handle(request: NextRequest) {
  const limited = rateLimit(request, 20);
  if (limited) return refuse(429, 'rate_limited', 'Too many requests; slow down', { retryable: true }, { 'Retry-After': limited.headers.get('Retry-After') || '60' });
  const net = concordiumNetwork();
  if (!net || !concordiumPayEnabled()) {
    return refuse(503, 'concordium_pay_disabled', 'Concordium payments are not enabled on this server', { retryable: false });
  }

  const auth = await authenticateBot(request);
  if (auth instanceof NextResponse) {
    return refuse(auth.status, auth.status === 401 ? 'unauthorized' : 'forbidden', "Send this agent's BotHire API key: Authorization: Bearer bh_…", { retryable: false });
  }
  const buyer: any = auth.bot;

  let token = '';
  try {
    const body = await request.json();
    token = typeof body?.token === 'string' ? body.token.trim().toLowerCase() : '';
  } catch { /* fall through */ }
  if (!/^0x[0-9a-f]{40}$/.test(token)) {
    return refuse(400, 'invalid_token_address', 'Send { "token": "0x…" }: a token contract address on BNB Chain', { retryable: false });
  }

  const sig = request.headers.get('payment-signature') || request.headers.get('x-payment');
  let payload: any = null;
  let pid: string | null = null;
  if (sig) {
    try {
      payload = decodePaymentSignatureHeader(sig);
    } catch {
      return refuse(400, 'invalid_payment_header', 'PAYMENT-SIGNATURE is not a valid x402 payment payload', { retryable: false });
    }
    pid = paymentId(payload);
    if (!pid) return refuse(400, 'invalid_payment_header', 'PAYMENT-SIGNATURE carries no Concordium signedTransaction', { retryable: false });
    // A payment we have already seen: deliver (or report) instead of paying twice.
    const seen: any = await (await payments()).findOne({ _id: pid } as any);
    if (seen) {
      if (seen.buyer_bot_id !== auth.bot_id) return refuse(409, 'payment_already_used', 'This payment was already used by another agent', { retryable: false });
      if (seen.token && seen.token !== token) {
        return json({ error: 'payment_bound_to_other_token', message: `This payment already bought a check for ${seen.token}. Resend with that token, or make a new payment for this one.`, charged: 'already_paid', retryable: false }, 409);
      }
      const replayed = await replay(net, seen);
      if (replayed) return replayed;
      // null: that earlier attempt never reached the chain and has expired; handle this as a fresh payment.
    }
  }

  const providerId = process.env.MEME_DESK_BOT_ID;
  if (!providerId) return refuse(503, 'provider_not_configured', 'Token Check provider is not configured on this server', { retryable: false });
  if (auth.bot_id === providerId) return refuse(409, 'cannot_buy_from_self', 'Cannot buy from yourself', { retryable: false });
  const provider: any = await findOne('bots', { _id: providerId });

  // Both sides verified, re-checked now (fail closed).
  let buyerCcd, providerCcd;
  try {
    [buyerCcd, providerCcd] = await Promise.all([
      concordiumStatusFor(auth.bot_id, buyer.concordium, isWalletProven(buyer) ? buyer.wallet_address : null, { fresh: true }),
      concordiumStatusFor(providerId, provider?.concordium, provider && isWalletProven(provider) ? provider.wallet_address : null, { fresh: true }),
    ]);
  } catch {
    return refuse(503, 'registry_unreachable', 'Concordium Agent Registry unreachable; try again shortly', { retryable: true }, { 'Retry-After': '10' });
  }
  if (!buyerCcd?.verified || !buyerCcd.owner_account) {
    return refuse(403, 'buyer_not_verified', 'This service is for agents Verified by Concordium', {
      retryable: false,
      issues: buyerCcd?.issues || ['no badge linked'],
      hint: 'Link a Concordium Agent Registry badge first: see "Verified by Concordium" in https://www.bothire.io/skill.md',
    });
  }
  if (!providerCcd?.verified || !providerCcd.wallet_bound || !providerCcd.owner_account) {
    return refuse(503, 'provider_not_verified', 'The provider is not currently Verified by Concordium', { retryable: true }, { 'Retry-After': '60' });
  }

  // Refuse unknown tokens before taking any money.
  let check;
  try {
    check = await getCheck(token);
  } catch (e) {
    if (e instanceof UnknownToken) return refuse(422, 'unknown_token', `${e.message}. Try another token.`, { retryable: false });
    if (e instanceof TokenDataUnavailable) return refuse(503, 'token_data_unavailable', 'Token data is unavailable right now; try again shortly', { retryable: true }, { 'Retry-After': '30' });
    throw e;
  }

  const req = ccdRequirements(net, providerCcd.owner_account, PRICE_MICRO);
  const priceCcd = PRICE_MICRO / CCD_MICRO;
  if (!payload) {
    const resource = { url: URL_SELF, description: `BotHire Meme Desk Token Check (${priceCcd} CCD, Concordium ${net})`, mimeType: 'application/json' };
    const required = { x402Version: 2, error: 'Payment required', resource, accepts: [req] };
    return json(
      {
        ...required,
        charged: false,
        price: { amount_ccd: priceCcd, network_name: `Concordium ${net}`, test_funds: net === 'testnet' },
        pay_from: buyerCcd.owner_account,
        how_to_pay:
          `Pay ${priceCcd} ${net === 'testnet' ? 'test ' : ''}CCD on Concordium ${net} from your verified account ${buyerCcd.owner_account} to accepts[0].payTo. ` +
          'BotHire sponsors the transaction fee: you need the price in your account, nothing extra for fees. With @x402/concordium: ' +
          'new ExactConcordiumScheme({ accountAddress, signer }).createPaymentPayload(2, accepts[0]), then encodePaymentSignatureHeader({ x402Version: 2, accepted: accepts[0], payload }) ' +
          'from @x402/core/http. Resend this exact request (same body) with header PAYMENT-SIGNATURE. Nothing has been charged yet.',
      },
      402,
      { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(required as any), 'Cache-Control': 'no-store' },
    );
  }

  const acc: any = payload.accepted || {};
  if (acc.payTo !== req.payTo || String(acc.amount) !== req.amount || acc.network !== req.network || acc.scheme !== 'exact' || acc.asset !== req.asset) {
    return paymentRequired('payment_mismatch', 'Payment does not match the current requirements: nothing was charged. Build one new payment from accepts[0].', req, { retryable: false });
  }
  if (!sameAccount(paymentSender(payload), buyerCcd.owner_account)) {
    return refuse(403, 'wrong_payer', `Payment must come from your verified Concordium account ${buyerCcd.owner_account}. Nothing was charged.`, { accepts: [req], retryable: false });
  }

  if (recentAttempts(auth.bot_id).length >= 10) {
    return refuse(429, 'too_many_payment_attempts', 'Too many payment attempts; wait 10 minutes', { retryable: true }, { 'Retry-After': '600' });
  }

  const hdr = paymentHeader(payload);
  if (!hdr) return refuse(400, 'invalid_payment_header', 'PAYMENT-SIGNATURE carries no valid transaction header', { retryable: false });

  // Claim this payment id before settling, so two concurrent requests can't both submit it.
  const col = await payments();
  try {
    await col.insertOne({ _id: pid, state: 'settling', service: 'token-check', network: net, buyer_bot_id: auth.bot_id, buyer_account: buyerCcd.owner_account, provider_bot_id: providerId, provider_account: req.payTo, amount_micro_ccd: PRICE_MICRO, token, check, sender: hdr?.sender, nonce: hdr?.nonce, expiry: hdr?.expiry, created_at: new Date() } as any);
  } catch (e: any) {
    if (e?.code === 11000) return pendingResponse(net, null, 'This payment is already being settled.');
    throw e;
  }

  // From here on the CCD may move: every exit after submission tells the agent not to pay again.
  let settled;
  try {
    settled = await settleCcdPayment(net, payload, req, buyerCcd.owner_account);
  } catch (e) {
    console.error('[token-check/ccd] settle threw', e);
    recordAttempt(auth.bot_id);
    await col.updateOne({ _id: pid } as any, { $set: { state: 'pending', tx: null, updated_at: new Date() } }).catch(() => undefined);
    return pendingResponse(net, null);
  }
  if (settled.ok || settled.submitted) recordAttempt(auth.bot_id);
  if (settled.ok) {
    await col.updateOne({ _id: pid } as any, { $set: { state: 'done', tx: settled.tx, payer: settled.payer, response: settled.response, settled_at: new Date() } })
      .catch((e) => console.error('[token-check/ccd] CRITICAL: paid but row not updated', pid, settled.tx, e));
    return delivered(net, check, settled.tx, settled.payer, req.payTo, encodePaymentResponseHeader(settled.response));
  }
  if (settled.submitted) {
    await col.updateOne({ _id: pid } as any, { $set: { state: 'pending', tx: settled.tx || null, last_error: settled.error, updated_at: new Date() } })
      .catch((e) => console.error('[token-check/ccd] pending row not updated', pid, e));
    return pendingResponse(net, settled.tx);
  }
  await col.deleteOne({ _id: pid } as any); // nothing moved: the agent may fix and retry
  if (settled.status === 402) return paymentRequired(settled.code, `${settled.error}. Nothing was charged; fix it and send one new payment built from accepts[0].`, req, { retryable: false });
  return refuse(settled.status, settled.code, `${settled.error}. Nothing was charged.`, {
    retryable: settled.status >= 500,
    ...(settled.status >= 500 ? { hint: 'Resend the same request with the same PAYMENT-SIGNATURE in a few seconds.' } : {}),
  }, settled.status >= 500 ? { 'Retry-After': '10' } : {});
}

function delivered(net: 'testnet' | 'mainnet', check: unknown, tx: string, from: string, to: string, responseHeader?: string) {
  return json(
    {
      check,
      payment: { network: net, transaction: tx, explorer: explorerTxUrl(net, tx), amount_ccd: PRICE_MICRO / CCD_MICRO, from, to, fee_paid_by: 'BotHire' },
    },
    200,
    responseHeader ? { 'PAYMENT-RESPONSE': responseHeader } : {},
  );
}

function pendingResponse(net: 'testnet' | 'mainnet', tx: string | null | undefined, lead = 'Your payment was submitted and may still finalize.') {
  return json(
    {
      error: 'payment_pending',
      message: `${lead} Do NOT pay again: resend the same request with the same PAYMENT-SIGNATURE to collect your result.`,
      retryable: true,
      transaction: tx || null,
      explorer: tx ? explorerTxUrl(net, tx) : null,
      charged: 'unknown',
    },
    202,
    { 'Retry-After': '15' },
  );
}

/**
 * A payment id we have seen before: return the stored result, or re-check a pending transfer. Returns
 * null when that earlier attempt provably never reached the chain and has expired (its row is removed),
 * so the same nonce can be paid again instead of being locked out.
 */
async function replay(net: 'testnet' | 'mainnet', row: any): Promise<NextResponse | null> {
  if (row.state === 'done') {
    return delivered(net, row.check, row.tx, row.payer || row.buyer_account, row.provider_account, row.response ? encodePaymentResponseHeader(row.response) : undefined);
  }
  if (row.state === 'unresolved') return unresolvedResponse();
  if (row.state === 'pending' && row.tx) {
    const ok = await ccdTxSucceeded(net, row.tx, row.buyer_account, row.provider_account, row.amount_micro_ccd);
    const col = await payments();
    if (ok === true) {
      await col.updateOne({ _id: row._id } as any, { $set: { state: 'done', payer: row.buyer_account, settled_at: new Date() } });
      return delivered(net, row.check, row.tx, row.buyer_account, row.provider_account);
    }
    if (ok === false) {
      await col.updateOne({ _id: row._id } as any, { $set: { state: 'failed', updated_at: new Date() } });
      return paymentFailedResponse(row.tx);
    }
  }
  if (row.state === 'failed') return paymentFailedResponse(row.tx || null);
  // Unresolved (settling / pending): once the transaction has expired, the sender's nonce tells us
  // whether it ever landed. Not used yet → it never did: release the claim.
  const expiredFor = Date.now() / 1000 - Number(row.expiry || 0);
  if (row.sender && Number.isSafeInteger(row.nonce) && expiredFor > 60) {
    const next = await ccdNextNonce(net, row.sender);
    if (next !== null && next <= BigInt(row.nonce)) {
      await (await payments()).deleteOne({ _id: row._id, state: { $in: ['settling', 'pending'] } } as any);
      return null;
    }
    if (next !== null) {
      // The nonce was used. If OUR transaction is unknown to the node after expiry, ours never landed.
      if (row.tx && (await ccdTxFound(net, row.tx)) === false) {
        await (await payments()).updateOne({ _id: row._id } as any, { $set: { state: 'failed', updated_at: new Date() } });
        return paymentFailedResponse(row.tx);
      }
      if (!row.tx) {
        // We can't tell which transaction used it: stop the retry loop and reconcile by hand.
        await (await payments()).updateOne({ _id: row._id } as any, { $set: { state: 'unresolved', updated_at: new Date() } });
        console.error('[token-check/ccd] payment unresolved, reconcile', row._id);
        return unresolvedResponse();
      }
    }
  }
  return pendingResponse(net, row.tx);
}

function paymentFailedResponse(tx: string | null) {
  return json(
    {
      error: 'payment_failed',
      message: 'This payment did not go through on chain; nothing was charged. Send the request again without PAYMENT-SIGNATURE for fresh requirements, then pay once.',
      transaction: tx,
      charged: false,
      retryable: false,
    },
    402,
  );
}

function unresolvedResponse() {
  return json(
    {
      error: 'payment_unresolved',
      message: 'We could not confirm this payment. Do not pay again: contact BotHire (https://www.bothire.io) with this PAYMENT-SIGNATURE and we will deliver your check or refund it.',
      charged: 'unknown',
      retryable: false,
    },
    409,
  );
}
