# CRB Token — Proof of Inference Mining

A Solana-based mining token where miners must generate natural language text containing specific words and solve a Proof-of-Work challenge. Rewards vest linearly over 30 days to promote long-term alignment.

## Mainnet Deployment

| Item | Value |
|------|-------|
| Program ID | `AcTXBfHAJgwt1sTn3DvTSKiiCKgShzGEZzq2zQrs5BnG` |
| Token Mint | `7HYtCPSMAUAujsSesBSyccK2hsdTfFW2sX63SoaedJh3` |
| Decimals | 3 |
| Max Supply | 100,000,000,000 CRB (100 billion) |
| Initial Reward | 25,000 CRB per solution |
| Halving Interval | Every 2,000,000 solutions |
| Vesting | 30-day linear release |
| Epoch Duration | 600 seconds (10 minutes) |
| Target Solutions | 50 per epoch |
| Difficulty Range | 4 - 250 |

## How It Works

### Mining Cycle

1. **Read State** — Fetch `mine_state` to get current epoch, difficulty, and challenge seed
2. **Derive Words** — Deterministically derive required words from the challenge seed
3. **Generate Text** — Create natural language text (256-800 bytes) containing all required words in order
4. **Proof of Work** — Find a nonce such that `keccak256(challenge_seed | miner_key | text | "||" | nonce)` has enough leading zero bits
5. **Submit Solution** — Submit the text + nonce + recipient on-chain (creates a Solution PDA)
6. **Advance Epoch** — After epoch ends, the crank advances to the next epoch
7. **Claim Reward** — Reward is added to the miner's VestingAccount (locked)
8. **Withdraw** — Vested tokens are minted to the recipient wallet as they unlock over 30 days

### Vesting

All mining rewards go through a 30-day linear vesting schedule:

- On **claim**, the reward is added to `VestingAccount.locked` (no tokens minted yet)
- Over 30 days, locked tokens drip into `unlocked` proportionally
- On **withdraw**, unlocked tokens are minted to the recipient's token account
- Each miner has one VestingAccount PDA (`seeds = ["vesting", miner_key]`)
- New claims stack on top of existing locked balance — the drip continues seamlessly

This prevents mine-and-dump behavior and encourages long-term participation.

> **Note:** If you stop mining, your locked tokens continue to vest normally. You can withdraw unlocked tokens at any time — nothing is lost.

### Recipient Separation

Miners can specify a separate **recipient** wallet for token rewards:

- The **miner wallet** pays gas and signs transactions
- The **recipient wallet** receives CRB tokens
- Set via `RECIPIENT` environment variable (defaults to miner wallet)

### Text Verification

The on-chain program performs a single O(n) pass with zero heap allocation:

- Length: 256-800 bytes
- Required words must appear in order as whole words with ≥40 byte gaps
- Vowel ratio 15%-55%, space ratio 10%-30%
- Max 5 consecutive consonants, average consonant cluster ≤3.5
- Common bigram frequency (th, he, in, er, an) ≥ len/80
- Byte diversity ≥28 distinct bytes
- Sentence structure: capital start, punctuation end
- At least 3 sentences, at least 1 question
- Mix of short (≤10 words) and long (≥20 words) sentences
- No duplicate sentences (FNV-1a hash, max 50 sentences)

### Difficulty Adjustment

Difficulty adjusts each epoch based on solution count vs target (50):
- Too many solutions → difficulty increases (log2 dampened, max +5)
- Too few solutions → difficulty decreases (log2 dampened, max -5)
- Zero solutions → max decrease (-5)
- Range: 4 (minimum) to 250 (maximum)

### Reward Schedule (Halving)

| Total Mined | Reward per Solution |
|-------------|-------------------|
| 0 - 1,999,999 | 25,000 CRB |
| 2,000,000 - 3,999,999 | 12,500 CRB |
| 4,000,000 - 5,999,999 | 6,250 CRB |
| ... | Halves every 2,000,000 solutions |

## Architecture

Zero write-lock contention design:

- `submit_solution` reads `mine_state` as **read-only** — no shared write locks
- Each solution creates its own PDA: `seeds = ["solution", miner_key, epoch_bytes]`
- Unlimited parallel miners with zero transaction conflicts
- **Each miner can submit at most 1 solution per epoch** (PDA uniqueness: `seeds = ["solution", miner_key, epoch]`)
- Solution counting is passed by the crank during `advance_epoch`

### Instructions

| Instruction | Description |
|-------------|-------------|
| `initialize` | Create MineState PDA and token Mint |
| `submit_solution(text, nonce, recipient)` | Submit a mining solution |
| `advance_epoch(solution_count)` | Advance to next epoch, adjust difficulty |
| `create_vesting` | Create a VestingAccount for a miner (once) |
| `claim` | Claim reward into VestingAccount (locked) |
| `withdraw` | Mint vested (unlocked) tokens to recipient |
| `close_expired` | Close expired unclaimed solutions (500+ epochs old) |
| `reset_state` | Reset mining state (admin only, for contract upgrades/migrations only) |

## Quick Start

### Prerequisites

- [Solana CLI](https://docs.solanalabs.com/cli/install)
- [Node.js](https://nodejs.org/) v20+
- A Solana wallet with SOL for transaction fees

### 1. Create a Miner Wallet

```bash
solana-keygen new -o miner-keypair.json
solana address -k miner-keypair.json
```

Fund this address with SOL for transaction fees (~0.5 SOL recommended).

### 2. Install Dependencies

```bash
cd miner
npm install
```

### 3. Configure

```bash
# Required: path to your miner keypair
export KEYPAIR=/path/to/miner-keypair.json

# Optional: custom RPC endpoint
export RPC_URL=https://solana-rpc.publicnode.com

# Optional: separate recipient wallet for CRB tokens
export RECIPIENT=<recipient-wallet-address>
```

### 4. Start Mining

```bash
npx ts-node --transpile-only mainnet-miner.ts
```

The miner will:
1. Create a VestingAccount (first run only)
2. Submit solutions each epoch
3. Advance epochs and claim rewards
4. Periodically withdraw vested tokens

### Cost Estimate

- Net cost per epoch: ~0.001-0.003 SOL
- 0.5 SOL is enough for several days of mining
- Solution PDA rent is returned on claim

## Word List

200 common English words (4-8 letters) are used for text requirements. The number of required words scales with difficulty:

| Difficulty | Required Words |
|-----------|---------------|
| ≤ 10 | 3 |
| ≤ 15 | 4 |
| ≤ 20 | 5 |
| ≤ 30 | 6 |
| ≤ 40 | 7 |
| > 40 | 8 |

## FAQ / Troubleshooting

| Problem | Solution |
|---------|----------|
| `Account not found` | First run — VestingAccount will be created automatically |
| `Epoch not ended` | Wait for current epoch to end before claiming |
| `Nothing to withdraw` | Vesting period too short, wait for tokens to unlock |
| `AlreadySubmitted (0x0)` | You already submitted this epoch, wait for next one |
| `InsufficientDifficulty` | Nonce doesn't meet difficulty, miner retries automatically |
| `MaxSupplyReached` | All 100B CRB have been mined |

## License

MIT
