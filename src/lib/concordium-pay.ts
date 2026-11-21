/**
 * x402 payments on Concordium (exact scheme, V1 sponsored transactions), settled in-process.
 *
 * The paying agent builds a CCD transfer naming BotHire's sponsor account as fee payer and signs it as
 * sender; BotHire verifies it (amount, recipient, expiry, sender signature …), adds the sponsor
 * signature, submits and waits for finalization. The payer needs no CCD for fees, and BotHire never
 * holds the payer's key. The sponsor key can only pay fees: it is never the sender of a transfer.
 *
 * Off unless CONCORDIUM_NETWORK, CCD_SPONSOR_ADDRESS and CCD_SPONSOR_PRIVATE_KEY are set.
 */
import { ExactConcordiumScheme } from '@x402/concordium/exact/facilitator';
import {
  CONCORDIUM_MAINNET_CAIP2,
  CONCORDIUM_TESTNET_CAIP2,
  getConcordiumGrpcUrl,
  getExplorerTxUrl,
  parseGrpcUrl,
  toConcordiumFacilitatorSigner,
} from '@x402/concordium';
import type { PaymentPayload, PaymentRequirements, SettleResponse } from '@x402/core/types';
import { createHash } from 'crypto';
import { AccountAddress, TransactionHash } from '@concordium/web-sdk';
import { concordiumNetwork, isConcordiumAccount, type ConcordiumNetwork } from '@/lib/concordium';

export const CCD_MICRO = 1_000_000; // CCD has 6 decimals

export function ccdCaip2(net: ConcordiumNetwork): string {
  return net === 'mainnet' ? CONCORDIUM_MAINNET_CAIP2 : CONCORDIUM_TESTNET_CAIP2;
}

export function sponsorAddress(): string | undefined {
  const a = process.env.CCD_SPONSOR_ADDRESS;
  return isConcordiumAccount(a) ? a : undefined;
}

export function concordiumPayEnabled(): boolean {
  return !!concordiumNetwork() && !!sponsorAddress() && /^[0-9a-f]{64}$/i.test(process.env.CCD_SPONSOR_PRIVATE_KEY || '');
}

let facilitator: { net: ConcordiumNetwork; scheme: ExactConcordiumScheme } | undefined;
function getFacilitator(net: ConcordiumNetwork): ExactConcordiumScheme {
  if (facilitator?.net === net) return facilitator.scheme;
  const caip2 = ccdCaip2(net);
  const [host, port] = parseGrpcUrl(getConcordiumGrpcUrl(caip2 as any));
  const signer = toConcordiumFacilitatorSigner(sponsorAddress()!, process.env.CCD_SPONSOR_PRIVATE_KEY!, { host, port, useTls: true, network: caip2 as any });
  facilitator = { net, scheme: new ExactConcordiumScheme({ signer, requireFinalization: true, finalizationTimeoutMs: 20_000 }) };
  return facilitator.scheme;
}

/** PaymentRequirements for a CCD transfer of `microCcd` to `payTo`, fees sponsored by BotHire. */
export function ccdRequirements(net: ConcordiumNetwork, payTo: string, microCcd: number): PaymentRequirements {
  return {
    scheme: 'exact',
    network: ccdCaip2(net) as any,
    asset: 'CCD',
    amount: String(microCcd),
    payTo,
    maxTimeoutSeconds: 300,
    extra: { feePayer: sponsorAddress() },
  };
}

export function explorerTxUrl(net: ConcordiumNetwork, tx: string): string | undefined {
  return getExplorerTxUrl(ccdCaip2(net) as any, tx);
}

/** The sender written in the signed transaction header (what the facilitator verifies the signature against). */
export function paymentSender(payload: PaymentPayload): string {
  return String((payload?.payload as any)?.signedTransaction?.header?.sender || '');
}

/**
 * A stable id for one payment: (canonical sender account, nonce). A sender can use each nonce only
 * once on chain, and re-encoding the JSON can't change it, so this is safe for idempotency.
 */
export function paymentId(payload: PaymentPayload): string | null {
  const h = (payload?.payload as any)?.signedTransaction?.header;
  const canon = canonicalAccount(h?.sender);
  const nonce = canonicalNonce(h?.nonce);
  if (!canon || nonce === null) return null;
  return createHash('sha256').update(`${canon}:${nonce}`).digest('hex');
}

/** Nonce as a canonical decimal string ("05" and 5 are the same on chain), or null if invalid. */
function canonicalNonce(n: unknown): string | null {
  if (!(typeof n === 'number' || typeof n === 'string')) return null;
  if (!/^[0-9]{1,15}$/.test(String(n))) return null;
  const v = BigInt(String(n));
  return v >= BigInt(1) ? v.toString() : null;
}

/** An account's alias-independent identity: the first 29 bytes of its address. */
export function canonicalAccount(addr: unknown): string | null {
  if (!isConcordiumAccount(addr)) return null;
  try {
    return Buffer.from(AccountAddress.fromBase58(addr).decodedAddress).subarray(0, 29).toString('hex');
  } catch {
    return null;
  }
}

export function sameAccount(a: unknown, b: unknown): boolean {
  const x = canonicalAccount(a);
  return !!x && x === canonicalAccount(b);
}

/** The only transaction shape we sponsor: one plain CCD transfer at the standard energy (no memo). */
const TRANSFER_ENERGY = 300;
const MAX_SENDER_SIGNATURES = 4;

let grpc: { net: ConcordiumNetwork; client: any } | undefined;
async function grpcClient(net: ConcordiumNetwork) {
  if (grpc?.net === net) return grpc.client;
  const { ConcordiumGRPCNodeClient, credentials } = await import('@concordium/web-sdk/nodejs');
  const [host, port] = parseGrpcUrl(getConcordiumGrpcUrl(ccdCaip2(net) as any));
  grpc = { net, client: new ConcordiumGRPCNodeClient(host, port, credentials.createSsl(), { timeout: 8_000 }) };
  return grpc.client;
}

/**
 * Checks the facilitator doesn't make, so a payer can't make the sponsor pay fees for a transfer that
 * fails on chain: plain transfer only, standard energy, and enough AVAILABLE (unlocked) balance.
 */
async function preflight(net: ConcordiumNetwork, payload: PaymentPayload, req: PaymentRequirements): Promise<{ status: number; code: string; error: string } | null> {
  const st = (payload?.payload as any)?.signedTransaction;
  if (st?.payload?.type !== 'transfer') return { status: 402, code: 'payment_invalid', error: 'Payment invalid: only a plain CCD transfer is accepted (no memo)' };
  if (Number(st?.header?.executionEnergyAmount) !== TRANSFER_ENERGY) return { status: 402, code: 'payment_invalid', error: `Payment invalid: executionEnergyAmount must be ${TRANSFER_ENERGY}` };
  // The sponsor's fee grows with the number of sender signatures: accept ordinary accounts only.
  const sigCount = Object.values(st?.signatures?.sender || {}).reduce((n: number, cred: any) => n + Object.keys(cred || {}).length, 0);
  if (Number(st?.header?.numSignatures) > MAX_SENDER_SIGNATURES || sigCount > MAX_SENDER_SIGNATURES) {
    return { status: 402, code: 'payment_invalid', error: `Payment invalid: at most ${MAX_SENDER_SIGNATURES} sender signatures` };
  }
  try {
    const c = await grpcClient(net);
    const info: any = await c.getAccountInfo(AccountAddress.fromBase58(String(st.header.sender)));
    const available = BigInt(String(info?.accountAvailableBalance?.microCcdAmount ?? info?.accountAvailableBalance?.value ?? info?.accountAvailableBalance ?? 0));
    if (available < BigInt(req.amount)) {
      return { status: 402, code: 'insufficient_balance', error: `Your account needs ${Number(req.amount) / CCD_MICRO} CCD available (unlocked; staked or scheduled CCD doesn't count)` };
    }
  } catch {
    return { status: 503, code: 'payment_check_unavailable', error: 'Could not read the paying account right now' };
  }
  return null;
}

export type CcdSettlement =
  | { ok: true; tx: string; payer: string; response: SettleResponse }
  /** Rejected before anything was submitted: nothing was charged. */
  | { ok: false; submitted: false; status: number; code: string; error: string }
  /** Submitted but not confirmed (timeout / failed finalization / post-check): the CCD may have moved. */
  | { ok: false; submitted: true; tx: string; code: string; error: string };

/**
 * Verify, then settle (sponsor-sign, submit, wait for finalization). `expectedSender`, if given, must
 * be the transaction's sender: e.g. the paying agent's verified Concordium account.
 */
export async function settleCcdPayment(net: ConcordiumNetwork, payload: PaymentPayload, req: PaymentRequirements, expectedSender?: string): Promise<CcdSettlement> {
  const fac = getFacilitator(net);
  let v;
  try {
    v = await fac.verify(payload, req);
  } catch (e: any) {
    return { ok: false, submitted: false, status: 503, code: 'payment_check_unavailable', error: `Could not check the payment right now (${clip(e?.message || e)})` };
  }
  if (!v.isValid) {
    return { ok: false, submitted: false, status: 402, code: 'payment_invalid', error: `Payment invalid: ${v.invalidReason || 'unknown'}${v.invalidMessage ? ` (${clip(v.invalidMessage)})` : ''}` };
  }
  // The facilitator has verified the sender signature against the header sender: that is the payer.
  const sender = paymentSender(payload);
  if (expectedSender && (!sameAccount(sender, expectedSender) || (v.payer && !sameAccount(v.payer, expectedSender)))) {
    return { ok: false, submitted: false, status: 403, code: 'wrong_payer', error: `Payment must come from your verified Concordium account ${expectedSender}` };
  }
  const pre = await preflight(net, payload, req);
  if (pre) return { ok: false, submitted: false, ...pre };
  let s: SettleResponse;
  try {
    s = await fac.settle(payload, req);
  } catch (e: any) {
    // We can't tell whether the transaction reached the node.
    return { ok: false, submitted: true, tx: '', code: 'payment_unknown', error: `Settlement error: ${clip(e?.message || e)}` };
  }
  if (s.success && s.transaction) return { ok: true, tx: s.transaction, payer: s.payer || sender, response: s };
  if (s.transaction) return { ok: false, submitted: true, tx: s.transaction, code: 'payment_pending', error: `${s.errorReason || 'not confirmed'}${s.errorMessage ? ` (${clip(s.errorMessage)})` : ''}` };
  // A failed submit call may still have reached the node: treat it as unknown, never as "nothing moved".
  if (String(s.errorReason || '').startsWith('submission_failed')) {
    return { ok: false, submitted: true, tx: '', code: 'payment_unknown', error: `${s.errorReason}${s.errorMessage ? ` (${clip(s.errorMessage)})` : ''}` };
  }
  return { ok: false, submitted: false, status: 402, code: 'payment_invalid', error: `Settlement refused: ${s.errorReason || 'unknown'}${s.errorMessage ? ` (${clip(s.errorMessage)})` : ''}` };
}

/** Whether the node knows a transaction hash at all: false = not found, null = unknown. */
export async function ccdTxFound(net: ConcordiumNetwork, tx: string): Promise<boolean | null> {
  if (!/^[0-9a-f]{64}$/i.test(tx)) return null;
  try {
    const c = await grpcClient(net);
    await c.getBlockItemStatus(TransactionHash.fromHexString(tx));
    return true;
  } catch (e: any) {
    return /not.?found/i.test(String(e?.message || e)) || e?.code === 5 ? false : null;
  }
}

/** The sender's next on-chain nonce, or null if unreadable. A stored nonce below it has been used. */
export async function ccdNextNonce(net: ConcordiumNetwork, account: string): Promise<bigint | null> {
  try {
    const c = await grpcClient(net);
    const n: any = await c.getNextAccountNonce(AccountAddress.fromBase58(account));
    return BigInt(String(n?.nonce?.value ?? n?.nonce ?? ''));
  } catch {
    return null;
  }
}

/** Header facts of a payment, stored so an unfinished one can be resolved later. */
export function paymentHeader(payload: PaymentPayload): { sender: string; nonce: number; expiry: number } | null {
  const h = (payload?.payload as any)?.signedTransaction?.header;
  const cn = canonicalNonce(h?.nonce);
  const nonce = Number(cn);
  const expiry = Number(h?.expiry);
  if (!isConcordiumAccount(h?.sender) || cn === null || !Number.isSafeInteger(nonce) || !Number.isSafeInteger(expiry)) return null;
  return { sender: h.sender, nonce, expiry };
}

/**
 * Finalized outcome of a transfer WE submitted (hash from our own stored row): true = it moved exactly
 * `micro` from `from` to `to`, false = rejected or not that transfer, null = not final / unknown.
 */
export async function ccdTxSucceeded(net: ConcordiumNetwork, tx: string, from: string, to: string, micro: number): Promise<boolean | null> {
  if (!/^[0-9a-f]{64}$/i.test(tx)) return null;
  try {
    const c = await grpcClient(net);
    const st: any = await c.getBlockItemStatus(TransactionHash.fromHexString(tx));
    if (st?.status !== 'finalized') return null;
    const summary: any = st.outcome?.summary;
    if (summary?.type === 'accountTransaction' && summary?.transactionType === 'failed') return false;
    const t = summary?.transfer;
    const amount = String(t?.amount?.microCcdAmount ?? t?.amount?.value ?? t?.amount ?? '');
    const match = summary?.type === 'accountTransaction' && sameAccount(summary?.sender?.address ?? summary?.sender, from) && sameAccount(t?.to?.address ?? t?.to, to) && amount === String(micro);
    if (!match) {
      console.error('[concordium-pay] finalized tx does not look like the expected transfer', tx);
      return null; // unexpected shape: don't call it failed (that would tell a payer "nothing charged")
    }
    return true;
  } catch {
    return null;
  }
}

const clip = (v: unknown) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200);
