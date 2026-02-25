# CRB Mining Guide

## Quick Start

### Prerequisites

- Node.js v20+
- Solana CLI (optional, for wallet creation)
- A Solana wallet funded with SOL (0.5 SOL recommended)

### 1. Clone the Repository

```bash
git clone https://github.com/Gus567897/poi-token.git
cd poi-token/miner
npm install
```

### 2. Create a Miner Wallet

```bash
solana-keygen new -o miner-keypair.json
solana address -k miner-keypair.json
```

Fund this address with SOL for transaction fees.

### 3. Configure Environment

```bash
# Required: path to your miner keypair
export KEYPAIR=/path/to/miner-keypair.json

# Optional: custom RPC endpoint (default: https://solana-rpc.publicnode.com)
export RPC_URL=https://your-rpc-endpoint.com

# Optional: separate wallet to receive CRB tokens (defaults to miner wallet)
export RECIPIENT=<recipient-wallet-address>
```

### 4. Start Mining

```bash
npx ts-node --transpile-only mainnet-miner.ts
```

Run in the background:

```bash
nohup npx ts-node --transpile-only mainnet-miner.ts >> miner.log 2>&1 &
```

## How Mining Works

### Epoch Cycle

1. Read on-chain state to get current epoch, difficulty, and challenge seed
2. Derive required words from the challenge seed
3. Generate natural language text (256-800 bytes) containing all required words in order
4. Find a nonce such that `keccak256(seed | miner_key | text | "||" | nonce)` meets the difficulty target
5. Submit the solution on-chain
6. After the epoch ends, the miner automatically advances to the next epoch (permissionless — any wallet can call `advance_epoch`)
7. Claim reward into VestingAccount (locked)
8. Locked tokens vest linearly over 30 days — withdraw anytime as they unlock

### Text Generation

The reference miner uses **template-based text generation** — no LLM or AI API is required. Templates are hardcoded with word substitution to produce valid natural language text.

Advanced miners may use LLM APIs (e.g., OpenAI, Anthropic) for more diverse text generation, but this is entirely optional.

### On-Chain Text Verification

The contract performs a single O(n) pass to verify submitted text. All of the following must pass:

| Rule | Requirement |
|------|-------------|
| Length | 256 - 800 bytes |
| Required words | Must appear in order as whole words with ≥40 byte gaps between them |
| Vowel ratio | 15% - 55% |
| Space ratio | 10% - 30% |
| Max consecutive consonants | ≤ 5 |
| Average consonant cluster | ≤ 3.5 |
| Common bigram frequency | (th, he, in, er, an) ≥ len/80 |
| Byte diversity | ≥ 28 distinct bytes |
| Sentence structure | Capital letter start, punctuation end |
| Minimum sentences | ≥ 3 |
| Questions | ≥ 1 question mark |
| Sentence variety | At least 1 short (≤10 words) and 1 long (≥20 words) sentence |
| No duplicates | No duplicate sentences (FNV-1a hash, max 50 sentences) |

If any check fails, the transaction is rejected on-chain.

### Key Parameters

| Parameter | Value |
|-----------|-------|
| Epoch Duration | 600 seconds (10 minutes) |
| Target Solutions | 50 per epoch |
| Difficulty Range | 4 - 250 |
| Initial Reward | 25,000 CRB per solution |
| Halving Interval | Every 2,000,000 solutions |
| Vesting Period | 30-day linear release |
| Solutions per Miner | 1 per epoch max |

### Difficulty Adjustment

Adjusted at the end of each epoch based on solution count:
- Too many solutions → difficulty increases (log2 dampened, max +5)
- Too few solutions → difficulty decreases (log2 dampened, max -5)
- Zero solutions → maximum decrease (-5)

### Vesting

All mining rewards go through a 30-day linear vesting schedule:
- On claim, rewards are added to your VestingAccount in locked state
- Tokens unlock linearly over 30 days
- Withdraw unlocked tokens at any time
- If you stop mining, locked tokens continue to vest normally
- New claims stack on top of existing locked balance

## Contract Info

| Item | Value |
|------|-------|
| Program ID | `AcTXBfHAJgwt1sTn3DvTSKiiCKgShzGEZzq2zQrs5BnG` |
| Token Mint | `7HYtCPSMAUAujsSesBSyccK2hsdTfFW2sX63SoaedJh3` |
| Decimals | 3 |
| Max Supply | 100,000,000,000 CRB |

## FAQ

### RPC Selection

Public RPCs have rate limits. For better reliability, use a paid RPC:
- [Helius](https://dev.helius.xyz) — free tier with 1M requests/month
- [QuickNode](https://quicknode.com)
- [Alchemy](https://alchemy.com)

### Transaction Fees

Each solution submission costs ~0.000005 SOL plus priority fee. 0.5 SOL is enough for a long time.

### Multiple Miners

You can run multiple miner instances with different wallets. Each miner can submit at most 1 solution per epoch.

### Epoch Advancement

After an epoch ends, `advance_epoch` must be called to move to the next round. This is fully permissionless — the miner program calls it automatically. Even if your miner doesn't advance, other miners will.

### Do I Need an AI/LLM API?

No. The reference miner uses template-based text generation that meets all on-chain verification rules without any external API. You may optionally integrate an LLM for more creative text, but it is not required.
