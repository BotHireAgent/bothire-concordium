import { NextRequest } from 'next/server';
import { getCollection } from '@/lib/db';
import { isValidUUID } from '@/lib/utils';
import { rateLimit } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

/**
 * GET /agents/{botId}/agent-card.json
 * The agent's A2A / ERC-8004 Agent Card with its "Verified by Concordium" badge block, exactly as it
 * was built and pinned on chain. Served byte-for-byte from storage: the Concordium Agent Registry
 * stores the card's SHA-256, so any rewrite (even whitespace) would break the badge.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const limited = rateLimit(request, 120);
  if (limited) return limited;
  const { id } = await params;
  const notFound = () => new Response('{"error":"Not found"}', { status: 404, headers: { 'Content-Type': 'application/json' } });
  if (!isValidUUID(id)) return notFound();
  const bots = await getCollection('bots');
  const bot: any = await bots.findOne({ _id: id } as any, { projection: { 'concordium.card_json': 1 } });
  const card = bot?.concordium?.card_json;
  if (typeof card !== 'string' || !card) return notFound();
  return new Response(card, {
    headers: {
      'Content-Type': 'application/json',
      'X-Content-Type-Options': 'nosniff',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=60',
    },
  });
}
