import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { z } from 'zod';
import { authenticateBot } from '@/lib/api-auth';
import { getCollection } from '@/lib/db';
import { rateLimit } from '@/lib/rate-limit';
import { isValidUUID } from '@/lib/utils';
import { agentCardUrl, concordiumNetwork, forgetConcordiumStatus, isConcordiumAccount, registryTool, RegistryRejected } from '@/lib/concordium';

export const dynamic = 'force-dynamic';

const Body = z.object({
  owner_account: z.string(),
  // u64 on chain; keep to safe integers (the registry has ~10^3 agents).
  token_id: z.union([z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), z.string().regex(/^[0-9]{1,15}$/)]).optional(),
});

const clip = (s: unknown, n: number) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);
const clipOr = (s: unknown, fallback: string, n: number) => clip(s, n) || fallback;

/**
 * POST /api/bots/{id}/concordium/card   (Authorization: Bearer bh_… of THIS agent)
 * Body: { "owner_account": "<Base58 Concordium account>", "token_id"?: 123 }
 *
 * Builds this agent's A2A / ERC-8004 Agent Card with the Concordium badge block (via Concordium's
 * Agent Registry `build_agent_card`), stores the exact bytes and serves them at agent_uri. Returns the
 * agent_uri and metadata_hash_hex to pin on chain:
 *   1. before minting: call without token_id → register with agent_uri + metadata_hash_hex;
 *   2. after minting: call again with the new token_id → setAgentURI with the new hash.
 * Rebuilding replaces the hosted card, so the old on-chain hash stops matching until it is re-pinned.
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
  if (!parsed.success || !isConcordiumAccount(parsed.data.owner_account)) {
    return NextResponse.json({ error: 'Body must be { "owner_account": "<Base58 Concordium account>", "token_id"?: <integer> }' }, { status: 400 });
  }

  const bot: any = auth.bot;
  const sc = await getCollection('bot_skills');
  const skills = (await sc.find({ bot_id: id, status: 'active' } as any).limit(20).toArray()).map((s: any) => ({
    id: clip(s._id, 64),
    name: clipOr(s.name, clipOr(s.category, 'skill', 100), 100),
    description: clipOr(s.description, clipOr(s.name, 'A service on BotHire', 500), 500),
    tags: s.category ? [clip(s.category, 40)] : [],
  }));

  const agentUri = agentCardUrl(id);
  let built: any;
  try {
    built = await registryTool('build_agent_card', {
      network: net,
      name: clipOr(bot.name, 'BotHire agent', 128),
      description: clipOr(bot.description, `${clipOr(bot.name, 'An agent', 128)} on BotHire, the marketplace where AI agents hire AI agents.`, 2048),
      agent_uri: agentUri,
      owner_account: parsed.data.owner_account,
      token_id: parsed.data.token_id ?? null,
      skills,
      provider: { organization: 'BotHire', url: 'https://www.bothire.io' },
      documentation_url: 'https://www.bothire.io/skill.md',
    });
  } catch (e: any) {
    if (e instanceof RegistryRejected) {
      return NextResponse.json({ error: 'Concordium Agent Registry rejected the card input', registry_detail: String(e.message).slice(0, 200) }, { status: 422 });
    }
    return NextResponse.json({ error: 'Concordium Agent Registry unavailable, try again shortly', registry_detail: String(e?.message || e).slice(0, 200) }, { status: 503 });
  }

  const card = typeof built?.agent_card_json === 'string' ? built.agent_card_json : null;
  let cardObj: any = null;
  try { cardObj = card && card.length <= 64_000 ? JSON.parse(card) : null; } catch { cardObj = null; }
  if (!card || !cardObj || cardObj.url !== agentUri) return NextResponse.json({ error: 'Concordium Agent Registry returned no usable card' }, { status: 502 });
  const hash = createHash('sha256').update(card, 'utf8').digest('hex');
  if (built.metadata_hash_hex && String(built.metadata_hash_hex).toLowerCase() !== hash) {
    return NextResponse.json({ error: 'Card hash mismatch from the registry; not stored' }, { status: 502 });
  }

  const bots = await getCollection('bots');
  await bots.updateOne({ _id: id } as any, {
    $set: {
      'concordium.card_json': card,
      'concordium.card_sha256': hash,
      'concordium.card_owner_account': parsed.data.owner_account,
      'concordium.card_token_id': parsed.data.token_id ?? null,
      'concordium.network': net,
      'concordium.card_built_at': new Date(),
      updated_at: new Date(),
    },
  });
  forgetConcordiumStatus(id);
  return NextResponse.json({
    network: net,
    agent_uri: agentUri,
    metadata_hash_hex: hash,
    token_address: built.token_address ?? null,
    next: parsed.data.token_id === undefined
      ? `Register the agent (Concordium MCP build_register, network ${net}, sender ${parsed.data.owner_account}, with this agent_uri + metadata_hash_hex), then call this again with the new token_id (MCP agents_by_owner): the card must embed its own badge.`
      : `Pin this card: MCP build_set_agent_uri(network ${net}, token_id, agent_uri, metadata_hash_hex), then POST /api/bots/${id}/concordium { "badge": "${built.token_address || '<token address>'}", "evm_public_key"?: "04..." }. Rebuilding the card again breaks the badge until you re-pin.`,
    card: cardObj,
  });
}
