/**
 * Concordium Agent Registry ("Verified by Concordium") for BotHire agents.
 *
 * On mainnet a Concordium account can only exist on an identity checked by an identity provider, so an
 * agent NFT owned by one (official CIS-8004 Agent Registry) has an accountable owner, who stays private.
 * On testnet identities are test data. BotHire never holds Concordium keys: it builds the agent's card,
 * points agents at sign-ready payloads from Concordium's public MCP server, and verifies the result.
 *
 * Verification is two-part:
 *  1. the badge (agent NFT token address) passes Concordium's check (registered, Active, the hosted
 *     card's SHA-256 matches the on-chain metadata_hash) AND its agent_uri is this bot's card URL;
 *  2. the bot's proven EVM wallet is bound to the badge's owner account in CIS-8 (owner_of_key),
 *     so "this 0x wallet on BotHire" and "this verified Concordium identity" are provably the same.
 *
 * Off unless CONCORDIUM_NETWORK is set ("testnet" for the hackathon; "mainnet" later).
 */
import { getAddress, isAddress, keccak256 } from 'viem';

const MCP_BASE = /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(process.env.CONCORDIUM_REGISTRY_MCP_URL || '')
  ? String(process.env.CONCORDIUM_REGISTRY_MCP_URL)
  : 'https://agent-registry-mcp.concordium.com';
const SITE = (process.env.NEXT_PUBLIC_SITE_URL || 'https://www.bothire.io').replace(/\/+$/, '');
const TIMEOUT_MS = 8_000;

export type ConcordiumNetwork = 'testnet' | 'mainnet';

export function concordiumNetwork(): ConcordiumNetwork | undefined {
  const v = process.env.CONCORDIUM_NETWORK;
  return v === 'testnet' || v === 'mainnet' ? v : undefined;
}

/** The public URL of a bot's Agent Card. This exact string is pinned on chain as agent_uri. */
export function agentCardUrl(botId: string): string {
  return `${SITE}/agents/${botId}/agent-card.json`;
}

/** Base58 Concordium account address (50 chars, Base58 alphabet). */
export function isConcordiumAccount(s: unknown): s is string {
  return typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{50}$/.test(s);
}

/** Base58Check CIS-2 token address of an agent NFT (short form, as returned by the registry). */
export function isBadgeAddress(s: unknown): s is string {
  return typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{8,40}$/.test(s);
}

/** A 4xx from the registry: the input is wrong (unknown badge, bad token id), not an outage. */
export class RegistryRejected extends Error {}

async function fetchText(url: string, init?: RequestInit): Promise<string> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { ...init, signal: ctl.signal, cache: 'no-store' });
    const text = await r.text();
    if (r.status >= 400 && r.status < 500 && r.status !== 429) {
      let msg = text.slice(0, 200);
      try { const j = JSON.parse(text); msg = String(j?.message || j?.error || msg).slice(0, 200); } catch { /* keep text */ }
      throw new RegistryRejected(msg);
    }
    if (!r.ok) throw new Error(`Concordium registry HTTP ${r.status}`);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/** Call one tool on Concordium's Agent Registry MCP server; returns the tool's JSON result. */
export async function registryTool(name: string, args: Record<string, unknown>): Promise<any> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  const text = await fetchText(`${MCP_BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body,
  });
  // Streamable HTTP may answer as SSE ("data: {...}") or plain JSON.
  const line = text.split('\n').find((l) => l.startsWith('data:'));
  const msg = JSON.parse(line ? line.slice(5) : text);
  if (msg.error) throw new Error(`Concordium registry: ${msg.error.message || 'tool error'}`);
  const res = msg.result;
  const raw = res?.content?.[0]?.text;
  // Tool errors come back as plain text (e.g. "config error: `token_id` not a u64"): that is a rejected input.
  if (res?.isError) throw new RegistryRejected(String(raw ?? 'tool error').slice(0, 300));
  if (res?.structuredContent !== undefined) return res.structuredContent;
  if (typeof raw !== 'string') return null;
  try { return JSON.parse(raw); } catch { throw new Error('Concordium registry returned a non-JSON tool result'); }
}

export type BadgeCheck = {
  valid: boolean;
  token_address: string;
  token_id: number | null;
  owner_account: string | null;
  agent_uri: string | null;
  status: string | null;
  /** Errors first, then warnings (the registry also warns about harmless things on valid badges). */
  issues: string[];
};

/** Concordium's own badge verdict for one agent NFT. Throws if the registry can't be reached. */
export async function checkBadge(badge: string, net: ConcordiumNetwork): Promise<BadgeCheck> {
  let text: string;
  try {
    text = await fetchText(`${MCP_BASE}/v1/check-badge/${encodeURIComponent(badge)}?network=${net}`);
  } catch (e) {
    if (e instanceof RegistryRejected) {
      return { valid: false, token_address: badge, token_id: null, owner_account: null, agent_uri: null, status: null, issues: [`error: ${e.message}`] };
    }
    throw e;
  }
  const d = JSON.parse(text);
  if (Array.isArray(d.agents)) throw new Error('Expected a badge token address, got a Concordium account');
  const owner = d.on_chain?.owner_account;
  const status = typeof d.on_chain?.status === 'string' ? d.on_chain.status : null;
  const issues = (Array.isArray(d.issues) ? d.issues : [])
    .map((i: any) => ({ sev: clipText(i?.severity || 'error', 10), msg: clipText(i?.message || i, 300) }))
    .sort((a: any, b: any) => (a.sev === 'error' ? 0 : 1) - (b.sev === 'error' ? 0 : 1))
    .map((i: any) => `${i.sev}: ${i.msg}`)
    .slice(0, 6);
  const tokenAddress = String(d.token_address || '');
  // Only Concordium's own registry counts: the token must be the one we asked about, Active, and the
  // registry must have matched the card's contracts to the official CIS-8004 / CIS-8 instances.
  const valid =
    d.badge_valid === true &&
    d.network === net &&
    tokenAddress === badge &&
    String(status).toLowerCase() === 'active' &&
    d.checks?.contracts_match === true &&
    d.checks?.hash_matches_on_chain === true &&
    isConcordiumAccount(owner);
  return {
    valid,
    token_address: badge,
    token_id: /^[0-9]{1,15}$/.test(String(d.token_id ?? '')) ? Number(d.token_id) : null,
    owner_account: isConcordiumAccount(owner) ? owner : null,
    agent_uri: typeof d.on_chain?.agent_uri === 'string' ? d.on_chain.agent_uri : null,
    status,
    issues,
  };
}

/** EVM keys are bound in CIS-8 under this namespace; one secp256k1 key is the same wallet on every EVM chain. */
export const CIS8_EVM_KEY = { namespace: 'eip155:1', key_type: 'secp256k1-uncompressed' } as const;

/**
 * Normalise an uncompressed secp256k1 public key (with or without 0x / 04 prefix) and check it
 * derives `address`. Returns the 130-hex-char "04…" form, or null if it isn't that wallet's key.
 */
export function evmPublicKeyFor(pubkey: string, address: string): string | null {
  let h = String(pubkey || '').trim().toLowerCase().replace(/^0x/, '');
  if (/^[0-9a-f]{128}$/.test(h)) h = '04' + h;
  if (!/^04[0-9a-f]{128}$/.test(h) || !isAddress(address)) return null;
  const derived = '0x' + keccak256(`0x${h.slice(2)}`).slice(-40);
  return getAddress(derived) === getAddress(address) ? h : null;
}

/** The Concordium account an EVM public key is bound to in CIS-8, or null if none. Throws if unreachable. */
export async function cis8OwnerOfEvmKey(publicKeyHex: string, net: ConcordiumNetwork): Promise<string | null> {
  const r = await registryTool('owner_of_key', { network: net, external_key: { ...CIS8_EVM_KEY, public_key_hex: publicKeyHex } });
  // Live shape: { network, owner, external_key: { namespace, key_type, public_key_hex }, proof_scheme, status }.
  // The registry stores the key compressed; accept it only if it is the same point we asked about.
  if (!r || typeof r !== 'object' || r.status !== 'Active' || r.network !== net || r.proof_scheme !== 'ethereum-personal-sign' || !isConcordiumAccount(r.owner)) return null;
  const k = r.external_key || {};
  if (k.namespace !== CIS8_EVM_KEY.namespace) return null;
  const x = publicKeyHex.slice(2, 66);
  const yOdd = parseInt(publicKeyHex.slice(-1), 16) % 2 === 1;
  const compressed = `${yOdd ? '03' : '02'}${x}`;
  const got = String(k.public_key_hex || '').toLowerCase();
  if (got !== publicKeyHex && got !== compressed) return null;
  return r.owner;
}

export type ConcordiumStatus = {
  network: ConcordiumNetwork;
  badge: string;
  token_id: number | null;
  owner_account: string | null;
  /** The badge passes Concordium's check and is about THIS bot (its agent_uri is the bot's card URL). */
  verified: boolean;
  /** The bot's proven EVM wallet is bound to the badge's owner account in CIS-8. */
  wallet_bound: boolean;
  /** Concordium's raw verification record for this badge (JSON). */
  badge_check_url: string;
  issues: string[];
};

const statusCache = new Map<string, { at: number; value: ConcordiumStatus | null }>();
const STATUS_TTL_MS = 5 * 60_000;
/** On a registry outage a cached verdict is reused for at most this long, and never for `fresh` checks. */
const STALE_MAX_MS = 30 * 60_000;
/** A `fresh` check still accepts a verdict this young (bounds upstream load; revocation lag ≤ 30 s). */
const FRESH_MAX_MS = 30_000;
const inflight = new Map<string, Promise<ConcordiumStatus>>();
const clipText = (s: unknown, n: number) => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').slice(0, n);

/**
 * Live verdict for a bot's linked badge. `stored` is the bot document's `concordium` field. Returns
 * null if nothing is linked; throws if Concordium can't be reached and nothing is cached.
 */
export async function concordiumStatusFor(botId: string, stored: any, walletAddress: string | null, opts: { fresh?: boolean } = {}): Promise<ConcordiumStatus | null> {
  const net = concordiumNetwork();
  if (!net || !stored?.badge || stored.network !== net) return null;
  const key = `${botId}:${stored.badge}:${walletAddress || ''}:${stored.evm_public_key || ''}`;
  const hit = statusCache.get(key);
  if (hit && Date.now() - hit.at < (opts.fresh ? FRESH_MAX_MS : STATUS_TTL_MS)) return hit.value;
  try {
    let p = inflight.get(key);
    if (!p) {
      p = computeStatus(botId, stored, walletAddress, net, key).finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    return await p;
  } catch (e) {
    if (!opts.fresh && hit && Date.now() - hit.at < STALE_MAX_MS) return hit.value; // bounded stale beats unknown
    throw e;
  }
}

async function computeStatus(botId: string, stored: any, walletAddress: string | null, net: ConcordiumNetwork, key: string): Promise<ConcordiumStatus> {
  {
    const c = await checkBadge(stored.badge, net);
    const aboutThisBot = c.agent_uri === agentCardUrl(botId);
    let bound = false;
    if (c.valid && aboutThisBot && c.owner_account && stored.evm_public_key && walletAddress && evmPublicKeyFor(stored.evm_public_key, walletAddress)) {
      bound = (await cis8OwnerOfEvmKey(stored.evm_public_key, net)) === c.owner_account;
    }
    const value: ConcordiumStatus = {
      network: net,
      badge: c.token_address,
      token_id: c.token_id,
      owner_account: c.owner_account,
      verified: c.valid && aboutThisBot,
      wallet_bound: bound,
      // Concordium's own verdict page for this badge (on-chain record + card hash check).
      badge_check_url: `${MCP_BASE}/v1/badge-check/${encodeURIComponent(c.token_address)}?network=${net}`,
      issues: aboutThisBot ? c.issues : [`error: the badge's agent_uri ${c.agent_uri ? 'points elsewhere' : 'is unset'}; it must be ${agentCardUrl(botId)}`, ...c.issues],
    };
    if (statusCache.size > 5000) statusCache.clear();
    statusCache.set(key, { at: Date.now(), value });
    return value;
  }
}

/**
 * The require_verified_provider gate: the provider must be verified AND wallet_bound right now.
 * Returns null to proceed, or { status, body } to refuse (nothing created / moved). Fails closed.
 */
export async function verifiedProviderRefusal(providerBotId: string): Promise<{ status: number; body: Record<string, unknown> } | null> {
  if (!concordiumNetwork()) {
    return { status: 501, body: { error: 'concordium_disabled', message: 'require_verified_provider: Concordium verification is not enabled on this server. Retry without require_verified_provider.', retryable: false } };
  }
  const { findOne } = await import('@/lib/db');
  const { isWalletProven } = await import('@/lib/agent-id');
  const pb: any = await findOne('bots', { _id: providerBotId });
  let ccd: ConcordiumStatus | null;
  try {
    ccd = await concordiumStatusFor(providerBotId, pb?.concordium, pb && isWalletProven(pb) ? pb.wallet_address : null, { fresh: true });
  } catch {
    return { status: 503, body: { error: 'require_verified_provider: Concordium Agent Registry unreachable; nothing was done, try again shortly' } };
  }
  if (ccd?.verified && ccd.wallet_bound) return null;
  return {
    status: 409,
    body: {
      error: !ccd?.verified ? 'Provider is not Verified by Concordium' : "Provider's payout wallet is not bound to its Concordium identity",
      provider_bot_id: providerBotId,
      issues: ccd?.issues?.length ? ccd.issues : [pb?.concordium?.badge ? 'badge linked for another network or no longer valid' : 'no badge linked'],
      hint: 'Nothing was done. Drop require_verified_provider to hire anyway, or pick a provider that verify_counterparty shows as verified with wallet_bound.',
    },
  };
}

/** Drop cached verdicts for a bot (after its card is rebuilt, the old verdict no longer holds). */
export function forgetConcordiumStatus(botId: string): void {
  for (const k of statusCache.keys()) if (k.startsWith(`${botId}:`)) statusCache.delete(k);
}

/** concordiumStatusFor with a time budget for page renders; null past the budget or on error. */
export async function concordiumStatusWithin(botId: string, stored: any, walletAddress: string | null, ms = 1500): Promise<ConcordiumStatus | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  try {
    return await Promise.race([concordiumStatusFor(botId, stored, walletAddress).catch(() => null), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
