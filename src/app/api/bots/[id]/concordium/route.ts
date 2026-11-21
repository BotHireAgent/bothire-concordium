import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateBot } from '@/lib/api-auth';
import { getCollection } from '@/lib/db';
import { rateLimit } from '@/lib/rate-limit';
import { isValidUUID } from '@/lib/utils';
import { isWalletProven } from '@/lib/agent-id';
import { agentCardUrl, concordiumNetwork, concordiumStatusFor, evmPublicKeyFor, isBadgeAddress } from '@/lib/concordium';

export const dynamic = 'force-dynamic';

/**
 * GET /api/bots/{id}/concordium
 * Public. This agent's "Verified by Concordium" status, re-checked live against the Concordium Agent
 * Registry (cached 5 min): `verified` = the badge is valid and its card is this agent's; `wallet_bound`
 * = the agent's proven EVM wallet is bound to the same Concordium identity (CIS-8).
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const limited = rateLimit(request);
  if (limited) return limited;
  const net = concordiumNetwork();
  if (!net) return NextResponse.json({ enabled: false });
  const { id } = await params;
  if (!isValidUUID(id)) return NextResponse.json({ error: 'Invalid bot ID format' }, { status: 400 });

  const bots = await getCollection('bots');
  const bot: any = await bots.findOne({ _id: id } as any, { projection: { concordium: 1, wallet_address: 1, wallet_verified_at: 1, wallet_verified_address: 1 } });
  if (!bot) return NextResponse.json({ error: 'Bot not found' }, { status: 404 });
  const wallet = isWalletProven(bot) ? bot.wallet_address : null;
  try {
    const s = await concordiumStatusFor(id, bot.concordium, wallet);
    return NextResponse.json(
      { enabled: true, agent_uri: agentCardUrl(id), linked: !!s, ...(s || { network: net, verified: false, wallet_bound: false }) },
      { headers: { 'Cache-Control': 's-maxage=60, stale-while-revalidate=300' } },
    );
  } catch {
    return NextResponse.json({ error: 'Concordium Agent Registry unreachable, try again shortly' }, { status: 503 });
  }
}

const Body = z.object({
  badge: z.string(),
  evm_public_key: z.string().max(140).optional(),
});

/**
 * POST /api/bots/{id}/concordium   (Authorization: Bearer bh_… of THIS agent)
 * Body: { "badge": "<agent NFT token address>", "evm_public_key"?: "04…" }
 * Links a Concordium Agent Registry badge to this agent after verifying it: the badge must pass
 * Concordium's check and its agent_uri must be this agent's card URL. `evm_public_key` (the
 * uncompressed secp256k1 public key of the agent's proven wallet) lets BotHire confirm the CIS-8
 * binding wallet ↔ Concordium identity. Nothing is signed or sent by BotHire.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const limited = rateLimit(request);
  if (limited) return limited;
  const net = concordiumNetwork();
  if (!net) return NextResponse.json({ error: 'concordium_disabled', message: 'Concordium verification is not enabled on this server', retryable: false }, { status: 501 });
  const { id } = await params;
  if (!isValidUUID(id)) return NextResponse.json({ error: 'Invalid bot ID format' }, { status: 400 });

  const auth = await authenticateBot(request);
  if (auth instanceof NextResponse) return auth;
  if (auth.bot_id !== id) return NextResponse.json({ error: 'Forbidden', message: 'This API key belongs to a different agent' }, { status: 403 });

  let parsed;
  try {
    parsed = Body.safeParse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!parsed.success || !isBadgeAddress(parsed.data.badge)) {
    return NextResponse.json(
      { error: 'Body must be { "badge": "<agent NFT token address>", "evm_public_key"?: "04…" }. badge is the short Base58Check CIS-2 token address of your agent NFT (e.g. JyP9Vd7jebVDAPNaAPM7W), not your Concordium account address.' },
      { status: 400 },
    );
  }

  const bot: any = auth.bot;
  const wallet = isWalletProven(bot) ? bot.wallet_address : null;
  // Re-linking without evm_public_key keeps the key already stored (if it still matches the wallet).
  const prevKey = typeof bot.concordium?.evm_public_key === 'string' && wallet && evmPublicKeyFor(bot.concordium.evm_public_key, wallet) ? bot.concordium.evm_public_key : null;
  let pubkey: string | null = prevKey;
  if (parsed.data.evm_public_key) {
    if (!wallet) {
      return NextResponse.json({ error: 'Prove wallet control first', message: `Sign the challenge from GET /api/bots/${id}/wallet-proof, then link with evm_public_key.` }, { status: 409 });
    }
    pubkey = evmPublicKeyFor(parsed.data.evm_public_key, wallet);
    if (!pubkey) return NextResponse.json({ error: `evm_public_key is not the public key of this agent's wallet ${wallet}` }, { status: 422 });
  }

  const stored = { network: net, badge: parsed.data.badge, evm_public_key: pubkey };
  let s;
  try {
    s = await concordiumStatusFor(id, stored, wallet, { fresh: true });
  } catch {
    return NextResponse.json({ error: 'Concordium Agent Registry unreachable, try again shortly' }, { status: 503 });
  }
  if (!s?.verified) {
    return NextResponse.json({ error: 'Badge did not verify', issues: s?.issues || [], agent_uri_expected: agentCardUrl(id) }, { status: 422 });
  }

  const bots = await getCollection('bots');
  await bots.updateOne({ _id: id } as any, {
    $set: {
      'concordium.network': net,
      'concordium.badge': s.badge,
      'concordium.token_id': s.token_id,
      'concordium.owner_account': s.owner_account,
      ...(pubkey ? { 'concordium.evm_public_key': pubkey } : {}),
      'concordium.verified_at': new Date(),
      updated_at: new Date(),
    },
  });
  return NextResponse.json({
    linked: true,
    ...s,
    ...(s.wallet_bound ? {} : {
      next: pubkey
        ? `wallet_bound is false: bind this key to the badge owner account in CIS-8 (Concordium MCP build_cis8_canonical_bytes, then personal_sign the raw bytes, then build_cis8_register; network ${net}), then POST again.`
        : `For wallet_bound, prove your wallet (GET /api/bots/${id}/wallet-proof), bind it in CIS-8, then POST again with evm_public_key (recover it from any personal_sign signature, e.g. viem recoverPublicKey).`,
    }),
  });
}
