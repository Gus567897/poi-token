#!/usr/bin/env npx ts-node
/**
 * PoI v2.2 Miner — single cycle: advance → submit → wait → claim
 */
import {
  Connection, Keypair, PublicKey, Transaction,
  TransactionInstruction, sendAndConfirmTransaction,
  ComputeBudgetProgram, SystemProgram,
} from '@solana/web3.js';
import { keccak_256 } from '@noble/hashes/sha3';
import { sha256 } from '@noble/hashes/sha256';
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountIdempotentInstruction,
} from '@solana/spl-token';
import * as fs from 'fs';

const RPC = 'http://127.0.0.1:8899';
const PROGRAM = new PublicKey('Aio7qosxjY32JuFfSrbpdv2kqYu3MF6YynPdai22HMAg');
const kpData = JSON.parse(fs.readFileSync('/root/.config/solana/id.json', 'utf-8'));
const wallet = Keypair.fromSecretKey(Uint8Array.from(kpData));
const conn = new Connection(RPC, 'confirmed');

function disc(name: string): Buffer {
  return Buffer.from(sha256(new TextEncoder().encode(`global:${name}`)).slice(0, 8));
}
const [stateAddr] = PublicKey.findProgramAddressSync([Buffer.from('mine_state')], PROGRAM);
const [mintAddr] = PublicKey.findProgramAddressSync([Buffer.from('mint')], PROGRAM);

// ── Word list & derivation ──
const WORDS = ["time","life","world","place","water","light","house","music","power","dream","heart","earth","ocean","river","cloud","stone","flame","voice","night","field","space","brain","truth","peace","storm","tower","plant","metal","glass","wheel","bridge","forest","garden","market","island","desert","silver","shadow","spirit","nature","energy","future","memory","moment","season","winter","summer","signal","system","design","method","reason","answer","letter","person","animal","flower","morning","evening","journey","history","culture","balance","freedom","pattern","shelter","surface","chapter","element","silence","think","learn","build","write","speak","dance","climb","watch","shine","carry","drive","paint","teach","reach","solve","share","trust","guide","shape","craft","chase","drift","weave","bloom","grasp","shift","sweep","trace","wander","gather","create","follow","listen","notice","wonder","happen","become","remain","travel","return","search","reveal","explore","imagine","connect","protect","reflect","develop","consider","discover","bright","quiet","gentle","strong","simple","hidden","golden","silent","frozen","bitter","tender","vivid","subtle","fierce","humble","steady","clever","honest","broken","sacred","unique","global","active","native","smooth","narrow","liquid","mental","social","visual","formal","casual","proper","remote","secure","stable","cosmic","ancient","modern","natural","digital","central","special","private","perfect","strange","careful","curious","distant","endless","often","never","always","slowly","deeply","gently","simply","nearly","barely","mostly","partly","surely","truly","fully","quite","still","maybe","hence","twice","ahead","apart","aside","along","after","again","early","later","since","almost","around"];

function wordCount(diff: number) { return diff<=10?3:diff<=15?4:diff<=20?5:diff<=30?6:diff<=40?7:8; }
function deriveWords(seed: Uint8Array, diff: number): string[] {
  const count = wordCount(diff);
  const used = new Set<number>(); const result: string[] = [];
  for (let i = 0; i < count; i++) {
    let idx = ((seed[i*2]<<8)|seed[i*2+1]) % WORDS.length;
    while (used.has(idx)) idx = (idx+1) % WORDS.length;
    used.add(idx); result.push(WORDS[idx]);
  }
  return result;
}

// ── Text generation (satisfies all verify.rs constraints) ──
// Structure: short sentence + question (long) + word sentences + filler
// Short & question go FIRST so they survive trimming
function generateText(words: string[]): string {
  const s: string[] = [];
  // Short sentence ≤10 words (required) — FIRST
  s.push("The morning air felt crisp and rather fresh.");
  // Question ≥20 words (required: has_question + has_long) — SECOND
  s.push("Have you ever wondered whether the inner workings of nature can truly be understood through careful thinking and honest observation?");
  // Word sentences (~90-110 bytes each, 12-18 words)
  const templates = [
    (w: string) => `The concept of ${w} has always been interesting to those who study the ancient patterns of nature.`,
    (w: string) => `In the morning light the meaning of ${w} becomes clearer to the careful observer.`,
    (w: string) => `There is a connection between ${w} and the traditions that have shaped modern thinking.`,
    (w: string) => `The inner nature of ${w} has been explored by wanderers who search for hidden patterns.`,
    (w: string) => `Perhaps understanding ${w} requires the careful observation of patterns the earth reveals.`,
    (w: string) => `One can discover the meaning of ${w} when the ancient garden comes alive with energy.`,
    (w: string) => `The significance of ${w} has interested thinkers and the patterns remain relevant today.`,
    (w: string) => `When evening arrives the deeper meaning of ${w} takes on a different character entirely.`,
  ];
  for (let i = 0; i < words.length; i++) {
    s.push(templates[i % templates.length](words[i]));
  }
  let text = s.join(' ');
  // Pad if needed
  const fillers = [
    "Another interesting pattern emerged when the ancient river changed direction and the water flowed differently.",
    "The garden path led through the forest where silver moonlight created gentle patterns on the earth.",
  ];
  let fi = 0;
  while (Buffer.from(text).length < 256 && fi < fillers.length) text += ' ' + fillers[fi++];
  // Trim from end if too long (short + question at front are safe)
  while (Buffer.from(text).length > 790) {
    const ld = text.lastIndexOf('.', text.length - 2);
    if (ld > 200) text = text.substring(0, ld + 1); else break;
  }
  return text;
}

// ── PoW ──
function meetsTarget(hash: Uint8Array, diff: number): boolean {
  for (let i = 0; i < diff; i++) { if ((hash[i>>3]>>(7-(i&7)))&1) return false; }
  return true;
}
function grindNonce(seed: Uint8Array, miner: Uint8Array, text: string, diff: number): bigint|null {
  const tb = new TextEncoder().encode(text);
  const sep = new TextEncoder().encode('||');
  const pLen = 32+32+tb.length+2;
  const buf = new Uint8Array(pLen+8);
  buf.set(seed,0); buf.set(miner,32); buf.set(tb,64); buf.set(sep,64+tb.length);
  const dv = new DataView(buf.buffer, pLen, 8);
  for (let n=0n; n<50_000_000n; n++) {
    dv.setBigUint64(0,n,true);
    if (meetsTarget(keccak_256(buf),diff)) return n;
    if (n % 1_000_000n === 0n && n > 0n) process.stdout.write(`  ${n/1_000_000n}M...`);
  }
  return null;
}

// ── Read state (v2.2 layout: 169 bytes) ──
async function readState() {
  const info = await conn.getAccountInfo(stateAddr);
  const d = info!.data;
  return {
    totalMined: Number(d.readBigUInt64LE(8)),
    difficulty: Number(d.readBigUInt64LE(16)),
    seed: new Uint8Array(d.slice(24, 56)),
    epoch: d.readBigUInt64LE(56),
    epochEnd: Number(d.readBigInt64LE(72)),
    solutions: Number(d.readBigUInt64LE(80)),
    totalSupply: d.readBigUInt64LE(96),
    mint: new PublicKey(d.slice(104, 136)),
    crankAuthority: new PublicKey(d.slice(136, 168)),
    bump: d[168],
  };
}
async function getBlockTime() {
  return (await conn.getBlockTime(await conn.getSlot()))!;
}

// ── Instructions ──
async function advanceEpoch(solutionCount: number) {
  const data = Buffer.concat([
    disc('advance_epoch'),
    (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(solutionCount)); return b; })(),
  ]);
  const tx = new Transaction().add(new TransactionInstruction({
    programId: PROGRAM,
    keys: [
      { pubkey: stateAddr, isSigner: false, isWritable: true },
      { pubkey: wallet.publicKey, isSigner: true, isWritable: false }, // crank
    ],
    data,
  }));
  return sendAndConfirmTransaction(conn, tx, [wallet], { commitment: 'confirmed' });
}

async function submitSolution(text: string, nonce: bigint, epoch: bigint) {
  const epochBuf = Buffer.alloc(8); epochBuf.writeBigUInt64LE(epoch);
  const [solAddr] = PublicKey.findProgramAddressSync(
    [Buffer.from('solution'), wallet.publicKey.toBuffer(), epochBuf], PROGRAM
  );
  const tb = new TextEncoder().encode(text);
  const tLen = Buffer.alloc(4); tLen.writeUInt32LE(tb.length);
  const nBuf = Buffer.alloc(8); nBuf.writeBigUInt64LE(nonce);
  const data = Buffer.concat([disc('submit_solution'), tLen, Buffer.from(tb), nBuf]);
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
  tx.add(new TransactionInstruction({
    programId: PROGRAM,
    keys: [
      { pubkey: stateAddr, isSigner: false, isWritable: false }, // READ-ONLY in v2.2
      { pubkey: solAddr, isSigner: false, isWritable: true },
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  }));
  return sendAndConfirmTransaction(conn, tx, [wallet], { commitment: 'confirmed' });
}

async function claim(epoch: bigint) {
  const epochBuf = Buffer.alloc(8); epochBuf.writeBigUInt64LE(epoch);
  const [solAddr] = PublicKey.findProgramAddressSync(
    [Buffer.from('solution'), wallet.publicKey.toBuffer(), epochBuf], PROGRAM
  );
  const recipientAta = await getAssociatedTokenAddress(mintAddr, wallet.publicKey);
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
  tx.add(createAssociatedTokenAccountIdempotentInstruction(
    wallet.publicKey, recipientAta, wallet.publicKey, mintAddr
  ));
  tx.add(new TransactionInstruction({
    programId: PROGRAM,
    keys: [
      { pubkey: stateAddr, isSigner: false, isWritable: true },
      { pubkey: solAddr, isSigner: false, isWritable: true },
      { pubkey: mintAddr, isSigner: false, isWritable: true },
      { pubkey: recipientAta, isSigner: false, isWritable: true },
      { pubkey: wallet.publicKey, isSigner: false, isWritable: true }, // rent_recipient
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: disc('claim'),
  }));
  return sendAndConfirmTransaction(conn, tx, [wallet], { commitment: 'confirmed' });
}

// ── Main ──
async function main() {
  console.log('⛏ PoI v2.2 Miner');
  console.log(`  Wallet: ${wallet.publicKey.toBase58()}`);

  let s = await readState();
  let now = await getBlockTime();
  console.log(`  Epoch: ${s.epoch}, Difficulty: ${s.difficulty}, Remaining: ${s.epochEnd - now}s`);

  // Step 1: Advance expired epoch
  if (now >= s.epochEnd) {
    console.log(`\n━━━ Step 1: Advance epoch (solutions=${s.solutions}) ━━━`);
    const sig = await advanceEpoch(s.solutions);
    console.log(`  ✅ Advanced: ${sig}`);
    s = await readState();
    now = await getBlockTime();
    console.log(`  New epoch: ${s.epoch}, Difficulty: ${s.difficulty}, Remaining: ${s.epochEnd - now}s`);
  }

  // Step 2: Submit solution
  console.log('\n━━━ Step 2: Submit solution ━━━');
  const words = deriveWords(s.seed, s.difficulty);
  console.log(`  Words (${words.length}): ${words.join(', ')}`);
  const text = generateText(words);
  console.log(`  Text: ${Buffer.from(text).length} bytes`);

  console.log(`  ⛏ Grinding nonce (difficulty=${s.difficulty})...`);
  const t0 = Date.now();
  const nonce = grindNonce(s.seed, wallet.publicKey.toBytes(), text, s.difficulty);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  if (nonce === null) { console.log('\n  ❌ No nonce found in 50M tries'); return; }
  console.log(`\n  ⛏ Nonce: ${nonce} (${elapsed}s)`);

  const submitSig = await submitSolution(text, nonce, s.epoch);
  console.log(`  ✅ Submitted: ${submitSig}`);

  // Step 3: Wait for epoch to end
  console.log('\n━━━ Step 3: Wait for epoch to end ━━━');
  s = await readState();
  now = await getBlockTime();
  const wait = s.epochEnd - now;
  if (wait > 0) {
    console.log(`  ⏰ Waiting ${wait}s...`);
    await new Promise(r => setTimeout(r, (wait + 3) * 1000));
  }

  // Step 4: Advance epoch again
  console.log('\n━━━ Step 4: Advance epoch ━━━');
  // Re-read to get current solution count
  s = await readState();
  // Wait for epoch to actually end
  for (let i = 0; i < 30; i++) {
    now = await getBlockTime();
    if (now >= s.epochEnd) break;
    await new Promise(r => setTimeout(r, 1000));
  }
  const advSig = await advanceEpoch(s.solutions);
  console.log(`  ✅ Advanced: ${advSig}`);

  // Step 5: Claim
  console.log('\n━━━ Step 5: Claim reward ━━━');
  const claimEpoch = s.epoch; // the epoch we submitted in
  const claimSig = await claim(claimEpoch);
  console.log(`  ✅ Claimed: ${claimSig}`);

  // Final state
  s = await readState();
  console.log('\n━━━ Final State ━━━');
  console.log(`  Epoch: ${s.epoch}`);
  console.log(`  Total mined: ${s.totalMined}`);
  console.log(`  Total supply: ${s.totalSupply}`);
  console.log(`  Difficulty: ${s.difficulty}`);
  console.log('\n🎉 Mining cycle complete!');
}

main().catch(e => { console.error('💥 Fatal:', e.message?.slice(0, 300) || e); process.exit(1); });
