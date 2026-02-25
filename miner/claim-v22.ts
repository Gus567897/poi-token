#!/usr/bin/env npx ts-node --transpile-only
/**
 * PoI v2.2 — Wait for epoch end, advance, then claim
 */
import {
  Connection, Keypair, PublicKey, Transaction,
  TransactionInstruction, sendAndConfirmTransaction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha256';
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountIdempotentInstruction,
} from '@solana/spl-token';
import * as fs from 'fs';

const PROGRAM = new PublicKey('Aio7qosxjY32JuFfSrbpdv2kqYu3MF6YynPdai22HMAg');
const conn = new Connection('http://127.0.0.1:8899', 'confirmed');
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync('/root/.config/solana/id.json', 'utf-8'))));
const [stateAddr] = PublicKey.findProgramAddressSync([Buffer.from('mine_state')], PROGRAM);
const [mintAddr] = PublicKey.findProgramAddressSync([Buffer.from('mint')], PROGRAM);

function disc(name: string): Buffer {
  return Buffer.from(sha256(new TextEncoder().encode(`global:${name}`)).slice(0, 8));
}

async function readState() {
  const d = (await conn.getAccountInfo(stateAddr))!.data;
  return {
    epoch: Number(d.readBigUInt64LE(56)),
    difficulty: Number(d.readBigUInt64LE(16)),
    epochEnd: Number(d.readBigInt64LE(72)),
    solutions: Number(d.readBigUInt64LE(80)),
    totalMined: Number(d.readBigUInt64LE(8)),
    totalSupply: Number(d.readBigUInt64LE(96)),
    bump: d[168],
  };
}

async function getBlockTime() {
  return (await conn.getBlockTime(await conn.getSlot()))!;
}

async function main() {
  let s = await readState();
  const bt = await getBlockTime();
  const remaining = s.epochEnd - bt;
  console.log(`⛏ Epoch: ${s.epoch}, Difficulty: ${s.difficulty}`);
  console.log(`  Remaining: ${remaining}s`);
  console.log(`  TotalMined: ${s.totalMined}, TotalSupply: ${s.totalSupply}`);

  // Check solution exists
  const epochBuf = Buffer.alloc(8); epochBuf.writeBigUInt64LE(BigInt(s.epoch));
  const [solAddr] = PublicKey.findProgramAddressSync(
    [Buffer.from('solution'), kp.publicKey.toBuffer(), epochBuf], PROGRAM
  );
  const solInfo = await conn.getAccountInfo(solAddr);
  if (!solInfo) {
    console.log('❌ No solution PDA for this epoch. Submit first!');
    return;
  }
  console.log('✅ Solution PDA exists');

  // Wait for epoch to end
  if (remaining > 0) {
    console.log(`\n⏰ Waiting ${remaining + 5}s for epoch to end...`);
    await new Promise(r => setTimeout(r, (remaining + 5) * 1000));
  }

  // Poll until block time passes epoch end
  for (let i = 0; i < 60; i++) {
    const now = await getBlockTime();
    if (now >= s.epochEnd) break;
    console.log(`  Polling... blockTime=${now}, epochEnd=${s.epochEnd}`);
    await new Promise(r => setTimeout(r, 2000));
  }

  // Advance epoch (solution_count = 1 since we're the only miner)
  console.log('\n━━━ Advance epoch ━━━');
  {
    const data = Buffer.alloc(8 + 8);
    disc('advance_epoch').copy(data, 0);
    data.writeBigUInt64LE(1n, 8); // solution_count = 1
    const ix = new TransactionInstruction({
      programId: PROGRAM,
      keys: [
        { pubkey: stateAddr, isSigner: false, isWritable: true },
        { pubkey: kp.publicKey, isSigner: true, isWritable: false }, // crank
      ],
      data,
    });
    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(conn, tx, [kp], { commitment: 'confirmed' });
    console.log(`  ✅ Advanced: ${sig}`);
    s = await readState();
    console.log(`  New epoch: ${s.epoch}, Difficulty: ${s.difficulty}`);
  }

  // Claim
  console.log('\n━━━ Claim reward ━━━');
  {
    const ata = await getAssociatedTokenAddress(mintAddr, kp.publicKey);
    const createAta = createAssociatedTokenAccountIdempotentInstruction(
      kp.publicKey, ata, kp.publicKey, mintAddr
    );

    const data = disc('claim');
    const [, mintBump] = PublicKey.findProgramAddressSync([Buffer.from('mint')], PROGRAM);
    const ix = new TransactionInstruction({
      programId: PROGRAM,
      keys: [
        { pubkey: stateAddr, isSigner: false, isWritable: true },
        { pubkey: solAddr, isSigner: false, isWritable: true },
        { pubkey: mintAddr, isSigner: false, isWritable: true },
        { pubkey: ata, isSigner: false, isWritable: true },
        { pubkey: kp.publicKey, isSigner: false, isWritable: true }, // rent_recipient
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data,
    });
    const tx = new Transaction().add(createAta).add(ix);
    const sig = await sendAndConfirmTransaction(conn, tx, [kp], { commitment: 'confirmed' });
    console.log(`  ✅ Claimed: ${sig}`);

    s = await readState();
    console.log(`  TotalMined: ${s.totalMined}`);
    console.log(`  TotalSupply: ${s.totalSupply}`);
  }

  console.log('\n🎉 Done!');
}

main().catch(e => { console.error('💥 Fatal:', e.message?.slice(0, 500) || e); process.exit(1); });
