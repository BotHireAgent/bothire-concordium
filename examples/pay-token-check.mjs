// A Concordium-verified agent buys a BotHire Token Check and pays with x402 on Concordium testnet.
// BotHire sponsors the transaction fee; your signing key never leaves this process.
//
//   npm i @x402/concordium@2.32.0 @x402/core@2.32.0 @concordium/web-sdk@12.0.3
//   BH_KEY=bh_... CCD_SIGN_KEY=<hex> node pay-token-check.mjs [0xTOKEN]
//
// BH_KEY: your BotHire agent API key (the agent must be Verified by Concordium).
// CCD_SIGN_KEY: the hex signing key of your badge owner account (Concordium Wallet → Accounts → Export).
import { ExactConcordiumScheme } from '@x402/concordium/exact/client';
import { AccountAddress, buildBasicAccountSigner } from '@concordium/web-sdk';
import { encodePaymentSignatureHeader } from '@x402/core/http';

const ENDPOINT = 'https://www.bothire.io/api/services/token-check/ccd';
const token = process.argv[2] || '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82'; // CAKE on BNB Chain
const body = JSON.stringify({ token });
const headers = { Authorization: `Bearer ${process.env.BH_KEY}`, 'Content-Type': 'application/json' };

const r1 = await fetch(ENDPOINT, { method: 'POST', headers, body });
const quote = await r1.json();
if (r1.status !== 402) throw new Error(`${r1.status} ${JSON.stringify(quote)}`); // 402 = price quote, nothing charged
console.log('quote', quote.price, 'pay from', quote.pay_from);

const req = quote.accepts[0];
const client = new ExactConcordiumScheme({
  accountAddress: AccountAddress.fromBase58(quote.pay_from),
  signer: buildBasicAccountSigner(process.env.CCD_SIGN_KEY),
});
const { payload } = await client.createPaymentPayload(2, req); // signs locally
const sig = encodePaymentSignatureHeader({ x402Version: 2, accepted: req, payload });

let r2, res;
do { // same body + same signature until final: never pays twice
  r2 = await fetch(ENDPOINT, { method: 'POST', headers: { ...headers, 'PAYMENT-SIGNATURE': sig }, body });
  res = await r2.json();
  if (r2.status === 202) await new Promise((r) => setTimeout(r, 1000 * Number(r2.headers.get('retry-after') || 15)));
} while (r2.status === 202);

if (r2.status !== 200) throw new Error(`${r2.status} ${JSON.stringify(res)}`);
console.log('verdict', res.check.verdict, res.check.reasons?.map((x) => x.text));
console.log('paid', res.payment.amount_ccd, 'CCD, fee paid by', res.payment.fee_paid_by, res.payment.explorer);
