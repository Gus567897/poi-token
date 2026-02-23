/**
 * PoI v3.0 Mainnet Miner (with Vesting)
 * Continuously mines POI tokens on Solana mainnet.
 */
import {
  Connection, Keypair, Transaction, TransactionInstruction,
  SystemProgram, PublicKey, sendAndConfirmTransaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import { createHash } from "crypto";
import * as fs from "fs";

// ── Config ──
const RPC_URL = process.env.RPC_URL || "https://solana-rpc.publicnode.com";
const PROGRAM_ID = new PublicKey("AcTXBfHAJgwt1sTn3DvTSKiiCKgShzGEZzq2zQrs5BnG");
const KEYPAIR_PATH = process.env.KEYPAIR || "./miner-keypair.json";

const conn = new Connection(RPC_URL, "confirmed");
const miner = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf8")))
);

// Recipient wallet for CRB tokens (defaults to miner if not set)
const RECIPIENT = process.env.RECIPIENT
  ? new PublicKey(process.env.RECIPIENT)
  : miner.publicKey;

// ── PDAs ──
const [stateAddr] = PublicKey.findProgramAddressSync([Buffer.from("mine_state")], PROGRAM_ID);
const [mintAddr] = PublicKey.findProgramAddressSync([Buffer.from("mint")], PROGRAM_ID);
const [vestingAddr] = PublicKey.findProgramAddressSync([Buffer.from("vesting"), miner.publicKey.toBuffer()], PROGRAM_ID);

function disc(name: string) {
  return createHash("sha256").update("global:" + name).digest().subarray(0, 8);
}

// ── Word list (exact match with contract words.rs — 200 words) ──
const WORDLIST: string[] = [
  "time","life","world","place","water","light","house","music","power","dream",
  "heart","earth","ocean","river","cloud","stone","flame","voice","night","field",
  "space","brain","truth","peace","storm","tower","plant","metal","glass","wheel",
  "bridge","forest","garden","market","island","desert","silver","shadow","spirit","nature",
  "energy","future","memory","moment","season","winter","summer","signal","system","design",
  "method","reason","answer","letter","person","animal","flower","morning","evening","journey",
  "history","culture","balance","freedom","pattern","shelter","surface","chapter","element","silence",
  "think","learn","build","write","speak","dance","climb","watch","shine","carry",
  "drive","paint","teach","reach","solve","share","trust","guide","shape","craft",
  "chase","drift","weave","bloom","grasp","shift","sweep","trace","wander","gather",
  "create","follow","listen","notice","wonder","happen","become","remain","travel","return",
  "search","reveal","explore","imagine","connect","protect","reflect","develop","consider","discover",
  "bright","quiet","gentle","strong","simple","hidden","golden","silent","frozen","bitter",
  "tender","vivid","subtle","fierce","humble","steady","clever","honest","broken","sacred",
  "unique","global","active","native","smooth","narrow","liquid","mental","social","visual",
  "formal","casual","proper","remote","secure","stable","cosmic","ancient","modern","natural",
  "digital","central","special","private","perfect","strange","careful","curious","distant","endless",
  "often","never","always","slowly","deeply","gently","simply","nearly","barely","mostly",
  "partly","surely","truly","fully","quite","still","maybe","hence","twice","ahead",
  "apart","aside","along","after","again","early","later","since","almost","around",
];

// ── Derive required words from challenge_seed (matches contract logic) ──
function wordCountForDifficulty(difficulty: number): number {
  if (difficulty <= 10) return 3;
  if (difficulty <= 15) return 4;
  if (difficulty <= 20) return 5;
  if (difficulty <= 30) return 6;
  if (difficulty <= 40) return 7;
  return 8;
}

function deriveWords(seed: Buffer, difficulty: number): string[] {
  const count = wordCountForDifficulty(difficulty);
  const used = new Set<number>();
  const words: string[] = [];

  for (let i = 0; i < count; i++) {
    const raw = (seed[i * 2]! << 8) | seed[i * 2 + 1]!;
    let idx = raw % WORDLIST.length;

    let tries = 0;
    while (used.has(idx) && tries < WORDLIST.length) {
      idx = (idx + 1) % WORDLIST.length;
      tries++;
    }
    if (tries >= WORDLIST.length) break;

    used.add(idx);
    words.push(WORDLIST[idx]!);
  }
  return words;
}

// ── Text generation (meets verify.rs: 256-800 bytes, words in order, ≥40 byte gap, sentences, etc.) ──
function generateText(words: string[]): string {
  const templates = [
    "The concept of {w} is something that many people think about when they consider the nature of existence and the patterns that emerge in their daily life every single morning.",
    "In the quiet moments of the evening, one can often find the {w} that connects all things together in ways that are both subtle and profoundly interesting to consider.",
    "Throughout history, great thinkers have always sought to understand the deeper meaning behind the {w} that shapes our world and guides our journey forward into the unknown.",
    "When we take the time to listen carefully, we begin to notice the gentle rhythm of {w} that flows through every single moment of our existence in rather interesting ways.",
    "The ancient stories have always reminded us that the {w} we discover in nature can teach us more than any other source of knowledge ever written in the history of the world.",
  ];
  const questions = [
    "Is there anything more fascinating than discovering the hidden {w} in the world around us?",
    "Have you ever wondered about the {w} that lies beneath the surface of everything we experience?",
    "Can we ever truly understand the {w} that shapes the patterns of our daily existence?",
  ];
  const closers = [
    "The answer remains unclear even today.",
    "Perhaps we shall never truly understand.",
    "The journey itself matters more than answers.",
  ];

  const parts: string[] = [];
  if (words.length === 1) {
    parts.push(templates[0]!.replace("{w}", words[0]!));
    parts.push(questions[0]!.replace("{w}", words[0]!));
    parts.push(closers[0]!);
  } else if (words.length === 2) {
    parts.push(templates[0]!.replace("{w}", words[0]!));
    parts.push(questions[0]!.replace("{w}", words[1]!));
    parts.push(closers[0]!);
  } else {
    parts.push(templates[0]!.replace("{w}", words[0]!));
    for (let i = 1; i < words.length - 1; i++) {
      parts.push(templates[i % templates.length]!.replace("{w}", words[i]!));
    }
    parts.push(questions[0]!.replace("{w}", words[words.length - 1]!));
    parts.push(closers[0]!);
  }
  return parts.join(" ");
}

// ── PoW grinding (Keccak-256, matches contract exactly) ──
// Hash = keccak256(challenge_seed | miner_key | text | "||" | nonce_le)
// Difficulty = number of leading zero BITS required
function checkDifficulty(hash: Buffer, difficulty: number): boolean {
  const fullBytes = Math.floor(difficulty / 8);
  const remainingBits = difficulty % 8;
  for (let i = 0; i < fullBytes; i++) {
    if (hash[i] !== 0) return false;
  }
  if (remainingBits > 0 && fullBytes < 32) {
    const mask = 0xFF << (8 - remainingBits);
    if ((hash[fullBytes]! & mask) !== 0) return false;
  }
  return true;
}

function grindNonce(
  challengeSeed: Buffer, minerKey: PublicKey, text: string, difficulty: number
): { nonce: bigint; hash: Buffer } {
  const { keccak256 } = require("js-sha3");
  const textBuf = Buffer.from(text, "utf-8");
  const separator = Buffer.from("||");
  const nonceBuf = Buffer.alloc(8);

  let nonce = BigInt(0);
  while (true) {
    nonceBuf.writeBigUInt64LE(nonce);
    const input = Buffer.concat([challengeSeed, minerKey.toBuffer(), textBuf, separator, nonceBuf]);
    const hashHex = keccak256(input);
    const hash = Buffer.from(hashHex, "hex");
    if (checkDifficulty(hash, difficulty)) return { nonce, hash };
    nonce++;
  }
}

// ── Read mine_state ──
async function readMineState() {
  const info = await conn.getAccountInfo(stateAddr);
  if (!info) throw new Error("mine_state not found");
  const d = info.data;
  // Layout (after 8-byte discriminator):
  //  8: total_mined (u64)
  // 16: difficulty (u64)
  // 24: challenge_seed ([u8;32])
  // 56: epoch_number (u64)
  // 64: epoch_start_time (i64)
  // 72: epoch_end_time (i64)
  // 80: solutions_in_epoch (u64)
  // 88: settled_in_epoch (u64)
  // 96: total_supply (u64)
  // 104: mint (Pubkey, 32)
  // 136: crank_authority (Pubkey, 32)
  // 168: bump (u8)
  return {
    totalMined: d.readBigUInt64LE(8),
    difficulty: Number(d.readBigUInt64LE(16)),
    challengeSeed: Buffer.from(d.subarray(24, 56)),
    epoch: Number(d.readBigUInt64LE(56)),
    epochStart: Number(d.readBigInt64LE(64)),
    epochEnd: Number(d.readBigInt64LE(72)),
    solutionsInEpoch: Number(d.readBigUInt64LE(80)),
    totalSupply: d.readBigUInt64LE(96),
  };
}

// ── Track solutions locally (getProgramAccounts blocked on public RPCs) ──
let localSolutionCount = 0;

// ── Submit solution ──
// Anchor args order: text (String), nonce (u64)
async function submitSolution(epoch: number, nonce: bigint, text: string) {
  const textBuf = Buffer.from(text, "utf-8");
  const [solnAddr] = PublicKey.findProgramAddressSync(
    [Buffer.from("solution"), miner.publicKey.toBuffer(), new Uint8Array(new BigUint64Array([BigInt(epoch)]).buffer)],
    PROGRAM_ID
  );

  // disc(8) + string_len(4) + string_bytes + nonce(8) + recipient(32)
  const data = Buffer.alloc(8 + 4 + textBuf.length + 8 + 32);
  disc("submit_solution").copy(data, 0);
  data.writeUInt32LE(textBuf.length, 8);
  textBuf.copy(data, 12);
  data.writeBigUInt64LE(nonce, 12 + textBuf.length);
  RECIPIENT.toBuffer().copy(data, 12 + textBuf.length + 8);

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }));
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }));
  tx.add(new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: stateAddr, isSigner: false, isWritable: false },
      { pubkey: solnAddr, isSigner: false, isWritable: true },
      { pubkey: miner.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  }));

  return sendAndConfirmTransaction(conn, tx, [miner]);
}

// ── Advance epoch (crank) ──
async function advanceEpoch(solutionCount: number) {
  const data = Buffer.alloc(8 + 8);
  disc("advance_epoch").copy(data, 0);
  data.writeBigUInt64LE(BigInt(solutionCount), 8);

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }));
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }));
  tx.add(new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: stateAddr, isSigner: false, isWritable: true },
      { pubkey: miner.publicKey, isSigner: true, isWritable: false },
    ],
    data,
  }));
  return sendAndConfirmTransaction(conn, tx, [miner]);
}

// ── Claim reward ──
async function createVesting() {
  const info = await conn.getAccountInfo(vestingAddr);
  if (info) { console.log("  VestingAccount already exists"); return; }

  console.log("  Creating VestingAccount...");
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }));
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }));
  tx.add(new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: vestingAddr, isSigner: false, isWritable: true },
      { pubkey: miner.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: disc("create_vesting"),
  }));
  const sig = await sendAndConfirmTransaction(conn, tx, [miner]);
  console.log(`  ✅ VestingAccount created: ${sig}`);
}

async function claimReward(epoch: number) {
  const [solnAddr] = PublicKey.findProgramAddressSync(
    [Buffer.from("solution"), miner.publicKey.toBuffer(), new Uint8Array(new BigUint64Array([BigInt(epoch)]).buffer)],
    PROGRAM_ID
  );

  const data = disc("claim");
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }));
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }));
  tx.add(new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: stateAddr, isSigner: false, isWritable: true },
      { pubkey: solnAddr, isSigner: false, isWritable: true },
      { pubkey: vestingAddr, isSigner: false, isWritable: true },
      { pubkey: miner.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  }));
  return sendAndConfirmTransaction(conn, tx, [miner]);
}

async function withdrawVested() {
  const recipient = RECIPIENT;
  const ata = await getAssociatedTokenAddress(mintAddr, recipient);

  // Ensure ATA exists
  const ataInfo = await conn.getAccountInfo(ata);
  if (!ataInfo) {
    console.log("  Creating token account for recipient...");
    const createTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(miner.publicKey, ata, recipient, mintAddr)
    );
    await sendAndConfirmTransaction(conn, createTx, [miner]);
  }

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }));
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }));
  tx.add(new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: stateAddr, isSigner: false, isWritable: false },
      { pubkey: vestingAddr, isSigner: false, isWritable: true },
      { pubkey: mintAddr, isSigner: false, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: miner.publicKey, isSigner: true, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: disc("withdraw"),
  }));
  return sendAndConfirmTransaction(conn, tx, [miner]);
}

// ── Main loop ──
async function main() {
  console.log("============================================================");
  console.log("  PoI v3.0 Mainnet Miner (with Vesting)");
  console.log("============================================================");
  console.log(`Miner:     ${miner.publicKey.toBase58()}`);
  console.log(`Recipient: ${RECIPIENT.toBase58()}`);
  console.log(`Program:   ${PROGRAM_ID.toBase58()}`);
  console.log(`RPC:       ${RPC_URL}`);
  const bal = await conn.getBalance(miner.publicKey);
  console.log(`Balance:   ${bal / 1e9} SOL\n`);

  // Ensure VestingAccount exists
  await createVesting();

  let lastSubmittedEpoch = -1;
  let withdrawCounter = 0;

  while (true) {
    try {
      const state = await readMineState();
      const now = Math.floor(Date.now() / 1000);
      const remaining = state.epochEnd - now;

      console.log(`[${new Date().toISOString()}] Epoch ${state.epoch} | Difficulty ${state.difficulty} | Ends in ${remaining}s`);

      // Epoch ended → advance + claim
      if (remaining <= 0) {
        console.log("  Epoch ended, advancing...");
        try {
          console.log(`  Solutions in epoch: ${localSolutionCount}`);
          const sig = await advanceEpoch(localSolutionCount);
          console.log(`  ✅ Epoch advanced: ${sig}`);
          localSolutionCount = 0;
        } catch (e: any) {
          console.log(`  ⚠️ Advance failed: ${e.message?.slice(0, 100)}`);
        }

        // Claim if we submitted this epoch
        if (lastSubmittedEpoch === state.epoch) {
          try {
            console.log(`  Claiming reward for epoch ${state.epoch}...`);
            const sig = await claimReward(state.epoch);
            console.log(`  ✅ Claimed: ${sig}`);
          } catch (e: any) {
            console.log(`  ⚠️ Claim failed: ${e.message?.slice(0, 100)}`);
          }
        }

        await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      // Already submitted this epoch
      if (lastSubmittedEpoch === state.epoch) {
        const wait = Math.min(remaining, 30);
        console.log(`  Already submitted for epoch ${state.epoch}, waiting ${wait}s...`);
        await new Promise(r => setTimeout(r, wait * 1000));
        continue;
      }

      // Mine!
      const words = deriveWords(state.challengeSeed, state.difficulty);
      const text = generateText(words);
      console.log(`  Required words (${words.length}): ${words.join(", ")}`);
      console.log(`  Grinding nonce (difficulty=${state.difficulty})...`);

      const t0 = Date.now();
      const { nonce } = grindNonce(state.challengeSeed, miner.publicKey, text, state.difficulty);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`  Found nonce ${nonce} in ${elapsed}s`);

      console.log("  Submitting solution...");
      const sig = await submitSolution(state.epoch, nonce, text);
      console.log(`  ✅ Submitted: ${sig}`);
      lastSubmittedEpoch = state.epoch;
      localSolutionCount++;
      withdrawCounter++;

      // Periodically withdraw vested tokens (every 10 epochs)
      if (withdrawCounter % 10 === 0) {
        try {
          await withdrawVested();
        } catch (e: any) {
          console.log(`  ⚠️ Withdraw skipped: ${e.message?.slice(0, 80)}`);
        }
      }

      // Wait for epoch to end
      const newState = await readMineState();
      const waitTime = Math.max(10, newState.epochEnd - Math.floor(Date.now() / 1000));
      console.log(`  Waiting ${waitTime}s for epoch to end...\n`);
      await new Promise(r => setTimeout(r, waitTime * 1000));

    } catch (e: any) {
      console.error(`  ❌ Error: ${e.message?.slice(0, 150)}`);
      await new Promise(r => setTimeout(r, 10000));
    }
  }
}

main().catch(console.error);
