use anchor_lang::prelude::*;
use anchor_lang::solana_program::keccak;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount};

pub mod verify;
pub mod words;

declare_id!("AcTXBfHAJgwt1sTn3DvTSKiiCKgShzGEZzq2zQrs5BnG");

// ============================================================
// Constants
// ============================================================

const MAX_SUPPLY: u64 = 100_000_000_000_000;               // 100B × 10^3 (3 decimals)
const INITIAL_REWARD: u64 = 25_000_000;                    // 25K CRB × 10^3
const HALVING_INTERVAL: u64 = 2_000_000;
const EPOCH_DURATION: i64 = 600;                            // 10 min
const TARGET_SOLUTIONS: u64 = 50;
const INITIAL_DIFFICULTY: u64 = 8;
const MAX_DIFFICULTY: u64 = 250;
const MIN_DIFFICULTY: u64 = 4;
const MAX_DIFFICULTY_ADJ: u64 = 5;
const CLAIM_EXPIRY_EPOCHS: u64 = 500;
const VESTING_DURATION: i64 = 30 * 24 * 3600;              // 30 days in seconds

// ============================================================
// Program
// ============================================================

#[program]
pub mod proof_of_inference {
    use super::*;

    /// Initialize the mining state and create the SPL token mint.
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let clock = Clock::get()?;
        let mine_state_key = ctx.accounts.mine_state.key();
        let mint_key = ctx.accounts.mint.key();
        let bump = ctx.bumps.mine_state;

        let seed_input = [
            clock.slot.to_le_bytes().as_ref(),
            clock.unix_timestamp.to_le_bytes().as_ref(),
            mine_state_key.as_ref(),
        ]
        .concat();
        let challenge_seed = keccak::hash(&seed_input).to_bytes();

        let state = &mut ctx.accounts.mine_state;
        state.total_mined = 0;
        state.difficulty = INITIAL_DIFFICULTY;
        state.challenge_seed = challenge_seed;
        state.epoch_number = 0;
        state.epoch_start_time = clock.unix_timestamp;
        state.epoch_end_time = clock.unix_timestamp + EPOCH_DURATION;
        state.solutions_in_epoch = 0;
        state.settled_in_epoch = 0;
        state.total_supply = 0;
        state.mint = mint_key;
        state.crank_authority = ctx.accounts.payer.key();
        state.bump = bump;

        Ok(())
    }

    /// Submit a mining solution.
    ///
    /// mine_state is READ-ONLY — zero write-lock contention.
    /// Each submit only creates a unique Solution PDA.
    pub fn submit_solution(ctx: Context<SubmitSolution>, text: String, nonce: u64, recipient: Pubkey) -> Result<()> {
        let clock = Clock::get()?;

        // ── Read state (mine_state is read-only, no write lock) ──
        let challenge_seed = ctx.accounts.mine_state.challenge_seed;
        let difficulty = ctx.accounts.mine_state.difficulty;
        let epoch_number = ctx.accounts.mine_state.epoch_number;
        let epoch_end_time = ctx.accounts.mine_state.epoch_end_time;
        let total_supply = ctx.accounts.mine_state.total_supply;

        // ── Epoch must be active ──
        require!(
            clock.unix_timestamp < epoch_end_time,
            ErrorCode::EpochEnded
        );

        // ── Supply cap ──
        require!(total_supply < MAX_SUPPLY, ErrorCode::MaxSupplyReached);

        // ── Derive required words ──
        let rw = words::derive_words(&challenge_seed, difficulty);
        let w0 = &rw.words[0][..rw.lens[0]];
        let w1 = &rw.words[1][..rw.lens[1]];
        let w2 = &rw.words[2][..rw.lens[2]];
        let w3 = &rw.words[3][..rw.lens[3]];
        let w4 = &rw.words[4][..rw.lens[4]];
        let w5 = &rw.words[5][..rw.lens[5]];
        let w6 = &rw.words[6][..rw.lens[6]];
        let w7 = &rw.words[7][..rw.lens[7]];
        let all_words: [&[u8]; 8] = [w0, w1, w2, w3, w4, w5, w6, w7];
        let active_words = &all_words[..rw.count];

        // ── Verify text constraints ──
        require!(
            verify::verify_text(text.as_bytes(), active_words),
            ErrorCode::InvalidText
        );

        // ── Compute hash ──
        let miner_key = ctx.accounts.miner.key();
        let nonce_bytes = nonce.to_le_bytes();
        let hash = keccak::hashv(&[
            &challenge_seed,
            miner_key.as_ref(),
            text.as_bytes(),
            b"||",
            &nonce_bytes,
        ]);
        let hash_bytes = hash.to_bytes();

        // ── Verify PoW difficulty ──
        require!(
            check_difficulty(&hash_bytes, difficulty),
            ErrorCode::InsufficientDifficulty
        );

        // ── Write Solution PDA ──
        let solution = &mut ctx.accounts.solution;
        solution.miner = miner_key;
        solution.recipient = recipient;
        solution.epoch = epoch_number;
        solution.nonce = nonce;
        solution.hash = hash_bytes;
        solution.bump = ctx.bumps.solution;

        Ok(())
    }

    /// Create a VestingAccount for a miner. Called once before first claim.
    pub fn create_vesting(ctx: Context<CreateVesting>) -> Result<()> {
        let v = &mut ctx.accounts.vesting;
        v.miner = ctx.accounts.miner.key();
        v.locked = 0;
        v.unlocked = 0;
        v.last_update = Clock::get()?.unix_timestamp;
        v.bump = ctx.bumps.vesting;
        Ok(())
    }

    /// Claim reward for a submitted solution.
    ///
    /// Does NOT mint tokens directly. Instead, adds reward to VestingAccount.locked.
    /// Tokens are minted later via `withdraw` as they vest over VESTING_DURATION.
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let clock = Clock::get()?;

        // ── Read state ──
        let current_epoch = ctx.accounts.mine_state.epoch_number;
        let epoch_end_time = ctx.accounts.mine_state.epoch_end_time;
        let total_mined = ctx.accounts.mine_state.total_mined;
        let total_supply = ctx.accounts.mine_state.total_supply;
        let solution_epoch = ctx.accounts.solution.epoch;

        // ── Solution's epoch must have ended ──
        let epoch_over = if solution_epoch < current_epoch {
            true
        } else if solution_epoch == current_epoch {
            clock.unix_timestamp >= epoch_end_time
        } else {
            false
        };
        require!(epoch_over, ErrorCode::EpochNotEnded);

        // ── Not expired ──
        require!(
            current_epoch < solution_epoch.saturating_add(CLAIM_EXPIRY_EPOCHS),
            ErrorCode::ClaimExpired
        );

        // ── Calculate reward ──
        let reward = calculate_reward(total_mined);
        let actual_reward = reward.min(MAX_SUPPLY.saturating_sub(total_supply));

        // ── Update vesting ──
        let vesting = &mut ctx.accounts.vesting;

        // Accrue any pending vested amount
        drip_vesting(vesting, clock.unix_timestamp);

        // Add new reward to locked
        vesting.locked = vesting.locked.checked_add(actual_reward).unwrap();

        // ── Update mine state (reserve supply, no mint yet) ──
        let state = &mut ctx.accounts.mine_state;
        state.total_mined += 1;
        state.total_supply = state.total_supply.checked_add(actual_reward).unwrap();

        // Solution PDA closed by Anchor `close` constraint → rent to miner
        Ok(())
    }

    /// Withdraw vested tokens.
    ///
    /// Calculates newly vested amount, then mints to recipient's token account.
    pub fn withdraw(ctx: Context<Withdraw>) -> Result<()> {
        let clock = Clock::get()?;
        let bump = ctx.accounts.mine_state.bump;

        // ── Update vesting ──
        let vesting = &mut ctx.accounts.vesting;
        drip_vesting(vesting, clock.unix_timestamp);

        let amount = vesting.unlocked;
        require!(amount > 0, ErrorCode::NothingToWithdraw);
        vesting.unlocked = 0;

        // ── CPI: mint tokens to recipient ──
        let seeds = &[b"mine_state".as_ref(), &[bump]];
        let signer_seeds = &[&seeds[..]];

        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.recipient_token_account.to_account_info(),
                    authority: ctx.accounts.mine_state.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
        )?;

        Ok(())
    }

    /// Advance to the next epoch (crank only).
    pub fn advance_epoch(ctx: Context<AdvanceEpoch>, solution_count: u64) -> Result<()> {
        let clock = Clock::get()?;
        let state = &mut ctx.accounts.mine_state;

        // ── Current epoch must have ended ──
        require!(
            clock.unix_timestamp >= state.epoch_end_time,
            ErrorCode::EpochNotEnded
        );

        // ── Record solutions in this epoch ──
        state.solutions_in_epoch = solution_count;

        // ── Adjust difficulty ──
        let target = TARGET_SOLUTIONS;
        if solution_count > target + target / 5 {
            let ratio = solution_count / target;
            let increase = log2_ceil(ratio).max(1).min(MAX_DIFFICULTY_ADJ);
            state.difficulty = state.difficulty.saturating_add(increase).min(MAX_DIFFICULTY);
        } else if solution_count == 0 {
            state.difficulty = state.difficulty.saturating_sub(MAX_DIFFICULTY_ADJ).max(MIN_DIFFICULTY);
        } else if solution_count < target.saturating_sub(target / 5) {
            let ratio = target / solution_count.max(1);
            let decrease = log2_ceil(ratio).max(1).min(MAX_DIFFICULTY_ADJ);
            state.difficulty = state.difficulty.saturating_sub(decrease).max(MIN_DIFFICULTY);
        }

        // ── New challenge seed ──
        let seed_input = [
            state.challenge_seed.as_ref(),
            clock.unix_timestamp.to_le_bytes().as_ref(),
            clock.slot.to_le_bytes().as_ref(),
            solution_count.to_le_bytes().as_ref(),
        ]
        .concat();
        state.challenge_seed = keccak::hash(&seed_input).to_bytes();

        // ── Advance epoch ──
        state.epoch_number += 1;
        state.epoch_start_time = clock.unix_timestamp;
        state.epoch_end_time = clock.unix_timestamp + EPOCH_DURATION;

        Ok(())
    }

    /// Close an expired, unclaimed solution. Rent goes to caller as cleanup incentive.
    pub fn close_expired(ctx: Context<CloseExpired>) -> Result<()> {
        let current_epoch = ctx.accounts.mine_state.epoch_number;
        let solution_epoch = ctx.accounts.solution.epoch;

        require!(
            current_epoch >= solution_epoch.saturating_add(CLAIM_EXPIRY_EPOCHS),
            ErrorCode::NotExpired
        );

        // Solution PDA closed by Anchor `close` constraint → rent to closer
        Ok(())
    }

    /// Transfer crank authority to a new address.
    pub fn set_crank_authority(ctx: Context<SetCrankAuthority>, new_authority: Pubkey) -> Result<()> {
        ctx.accounts.mine_state.crank_authority = new_authority;
        Ok(())
    }

    /// Create token metadata via Metaplex.

    /// Reset mining state. Crank authority only. For re-initialization.
    pub fn reset_state(ctx: Context<ResetState>) -> Result<()> {
        let clock = Clock::get()?;
        let state = &mut ctx.accounts.mine_state;

        let seed_input = [
            clock.slot.to_le_bytes().as_ref(),
            clock.unix_timestamp.to_le_bytes().as_ref(),
            state.key().as_ref(),
        ]
        .concat();
        let challenge_seed = keccak::hash(&seed_input).to_bytes();

        state.total_mined = 0;
        state.difficulty = INITIAL_DIFFICULTY;
        state.challenge_seed = challenge_seed;
        state.epoch_number = 0;
        state.epoch_start_time = clock.unix_timestamp;
        state.epoch_end_time = clock.unix_timestamp + EPOCH_DURATION;
        state.solutions_in_epoch = 0;
        state.settled_in_epoch = 0;
        state.total_supply = 0;
        // mint and crank_authority and bump stay the same

        Ok(())
    }

    pub fn create_metadata(
        ctx: Context<CreateMetadata>,
        name: String,
        symbol: String,
        uri: String,
    ) -> Result<()> {
        let bump = ctx.accounts.mine_state.bump;
        let seeds = &[b"mine_state".as_ref(), &[bump]];
        let signer_seeds = &[&seeds[..]];

        let metadata_accounts = mpl_token_metadata::instructions::CreateMetadataAccountV3CpiAccounts {
            metadata: &ctx.accounts.metadata.to_account_info(),
            mint: &ctx.accounts.mint.to_account_info(),
            mint_authority: &ctx.accounts.mine_state.to_account_info(),
            payer: &ctx.accounts.payer.to_account_info(),
            update_authority: (&ctx.accounts.mine_state.to_account_info(), true),
            system_program: &ctx.accounts.system_program.to_account_info(),
            rent: Some(&ctx.accounts.rent.to_account_info()),
        };

        let data_v2 = mpl_token_metadata::types::DataV2 {
            name,
            symbol,
            uri,
            seller_fee_basis_points: 0,
            creators: None,
            collection: None,
            uses: None,
        };

        mpl_token_metadata::instructions::CreateMetadataAccountV3Cpi::new(
            &ctx.accounts.token_metadata_program.to_account_info(),
            metadata_accounts,
            mpl_token_metadata::instructions::CreateMetadataAccountV3InstructionArgs {
                data: data_v2,
                is_mutable: true,
                collection_details: None,
            },
        ).invoke_signed(signer_seeds)?;

        Ok(())
    }
}

// ============================================================
// Helpers
// ============================================================

/// Drip vesting: move locked → unlocked based on elapsed time.
fn drip_vesting(v: &mut Account<VestingAccount>, now: i64) {
    if v.locked == 0 || now <= v.last_update {
        v.last_update = now;
        return;
    }
    let elapsed = now - v.last_update;
    let release = if elapsed >= VESTING_DURATION {
        v.locked
    } else {
        // Use u128 to avoid overflow
        (v.locked as u128 * elapsed as u128 / VESTING_DURATION as u128) as u64
    };
    v.unlocked += release;
    v.locked -= release;
    v.last_update = now;
}

/// Reward with halving: INITIAL_REWARD >> (total_mined / HALVING_INTERVAL)
fn calculate_reward(total_mined: u64) -> u64 {
    let halvings = total_mined / HALVING_INTERVAL;
    if halvings >= 64 {
        return 0;
    }
    INITIAL_REWARD >> halvings
}

/// Check that hash has at least `difficulty` leading zero bits.
fn check_difficulty(hash: &[u8; 32], difficulty: u64) -> bool {
    let full_bytes = (difficulty / 8) as usize;
    let remaining_bits = (difficulty % 8) as u8;

    for i in 0..full_bytes {
        if i >= 32 {
            return false;
        }
        if hash[i] != 0 {
            return false;
        }
    }

    if remaining_bits > 0 && full_bytes < 32 {
        let mask = 0xFF << (8 - remaining_bits);
        if hash[full_bytes] & mask != 0 {
            return false;
        }
    }

    true
}

/// Ceiling of log2(n), minimum 1.
fn log2_ceil(n: u64) -> u64 {
    if n <= 1 {
        return 0;
    }
    64 - (n - 1).leading_zeros() as u64
}

// ============================================================
// Account Structs
// ============================================================

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + MineState::INIT_SPACE,
        seeds = [b"mine_state"],
        bump,
    )]
    pub mine_state: Account<'info, MineState>,

    #[account(
        init,
        payer = payer,
        mint::decimals = 3,
        mint::authority = mine_state,
        seeds = [b"mint"],
        bump,
    )]
    pub mint: Account<'info, Mint>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct SubmitSolution<'info> {
    // READ-ONLY: no write lock acquired
    #[account(
        seeds = [b"mine_state"],
        bump = mine_state.bump,
    )]
    pub mine_state: Account<'info, MineState>,

    #[account(
        init,
        payer = miner,
        space = 8 + Solution::INIT_SPACE,
        seeds = [b"solution", miner.key().as_ref(), &mine_state.epoch_number.to_le_bytes()],
        bump,
    )]
    pub solution: Account<'info, Solution>,

    #[account(mut)]
    pub miner: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreateVesting<'info> {
    #[account(
        init,
        payer = miner,
        space = 8 + VestingAccount::INIT_SPACE,
        seeds = [b"vesting", miner.key().as_ref()],
        bump,
    )]
    pub vesting: Account<'info, VestingAccount>,

    #[account(mut)]
    pub miner: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(
        mut,
        seeds = [b"mine_state"],
        bump = mine_state.bump,
    )]
    pub mine_state: Account<'info, MineState>,

    #[account(
        mut,
        seeds = [b"solution", solution.miner.as_ref(), &solution.epoch.to_le_bytes()],
        bump = solution.bump,
        close = miner,
    )]
    pub solution: Account<'info, Solution>,

    #[account(
        mut,
        seeds = [b"vesting", solution.miner.as_ref()],
        bump = vesting.bump,
    )]
    pub vesting: Account<'info, VestingAccount>,

    #[account(
        mut,
        constraint = miner.key() == solution.miner @ ErrorCode::InvalidRecipient,
    )]
    pub miner: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(
        seeds = [b"mine_state"],
        bump = mine_state.bump,
    )]
    pub mine_state: Account<'info, MineState>,

    #[account(
        mut,
        seeds = [b"vesting", miner.key().as_ref()],
        bump = vesting.bump,
    )]
    pub vesting: Account<'info, VestingAccount>,

    #[account(
        mut,
        seeds = [b"mint"],
        bump,
    )]
    pub mint: Account<'info, Mint>,

    /// Token account to receive tokens. Miner signature is the authorization.
    #[account(
        mut,
        token::mint = mint,
    )]
    pub recipient_token_account: Account<'info, TokenAccount>,

    #[account(
        constraint = miner.key() == vesting.miner @ ErrorCode::Unauthorized
    )]
    pub miner: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct AdvanceEpoch<'info> {
    #[account(
        mut,
        seeds = [b"mine_state"],
        bump = mine_state.bump,
    )]
    pub mine_state: Account<'info, MineState>,

    /// Anyone can crank (permissionless)
    pub crank: Signer<'info>,
}

#[derive(Accounts)]
pub struct SetCrankAuthority<'info> {
    #[account(
        mut,
        seeds = [b"mine_state"],
        bump = mine_state.bump,
    )]
    pub mine_state: Account<'info, MineState>,

    #[account(
        constraint = authority.key() == mine_state.crank_authority @ ErrorCode::Unauthorized
    )]
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct ResetState<'info> {
    #[account(
        mut,
        seeds = [b"mine_state"],
        bump = mine_state.bump,
    )]
    pub mine_state: Account<'info, MineState>,

    #[account(
        constraint = authority.key() == mine_state.crank_authority @ ErrorCode::Unauthorized
    )]
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct CloseExpired<'info> {
    #[account(
        seeds = [b"mine_state"],
        bump = mine_state.bump,
    )]
    pub mine_state: Account<'info, MineState>,

    #[account(
        mut,
        seeds = [b"solution", solution.miner.as_ref(), &solution.epoch.to_le_bytes()],
        bump = solution.bump,
        close = closer,
    )]
    pub solution: Account<'info, Solution>,

    /// Anyone can close expired solutions. Rent goes to caller as cleanup incentive.
    #[account(mut)]
    pub closer: Signer<'info>,
}

#[derive(Accounts)]
pub struct CreateMetadata<'info> {
    #[account(
        seeds = [b"mine_state"],
        bump = mine_state.bump,
    )]
    pub mine_state: Account<'info, MineState>,

    #[account(
        seeds = [b"mint"],
        bump,
    )]
    pub mint: Account<'info, Mint>,

    /// CHECK: Created by Metaplex program
    #[account(mut)]
    pub metadata: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = payer.key() == mine_state.crank_authority @ ErrorCode::Unauthorized
    )]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,

    /// CHECK: Metaplex Token Metadata program
    #[account(address = mpl_token_metadata::ID)]
    pub token_metadata_program: UncheckedAccount<'info>,
}

// ============================================================
// State
// ============================================================

#[account]
#[derive(InitSpace)]
pub struct MineState {
    pub total_mined: u64,          // 8   — total solutions ever claimed
    pub difficulty: u64,           // 8
    pub challenge_seed: [u8; 32],  // 32
    pub epoch_number: u64,         // 8
    pub epoch_start_time: i64,     // 8
    pub epoch_end_time: i64,       // 8
    pub solutions_in_epoch: u64,   // 8   — set by crank during advance_epoch
    pub settled_in_epoch: u64,     // 8   — reserved for compatibility
    pub total_supply: u64,         // 8   — committed supply (locked + unlocked + released)
    pub mint: Pubkey,              // 32
    pub crank_authority: Pubkey,   // 32  — only this address can call advance_epoch
    pub bump: u8,                  // 1
}                                  // total: 161 + 8 discriminator = 169

#[account]
#[derive(InitSpace)]
pub struct Solution {
    pub miner: Pubkey,             // 32  — gas payer (submitter)
    pub recipient: Pubkey,         // 32  — token receiver
    pub epoch: u64,                // 8
    pub nonce: u64,                // 8
    pub hash: [u8; 32],            // 32
    pub bump: u8,                  // 1
}                                  // total: 113 + 8 discriminator = 121

#[account]
#[derive(InitSpace)]
pub struct VestingAccount {
    pub miner: Pubkey,             // 32  — gas payer / owner
    pub locked: u64,               // 8   — vesting, not yet available
    pub unlocked: u64,             // 8   — vested, ready to withdraw
    pub last_update: i64,          // 8   — last drip calculation time
    pub bump: u8,                  // 1
}                                  // total: 57 + 8 discriminator = 65

// ============================================================
// Errors
// ============================================================

#[error_code]
pub enum ErrorCode {
    #[msg("Text verification failed")]
    InvalidText,
    #[msg("Hash does not meet difficulty requirement")]
    InsufficientDifficulty,
    #[msg("Maximum token supply reached")]
    MaxSupplyReached,
    #[msg("Current epoch has ended, call advance_epoch first")]
    EpochEnded,
    #[msg("Epoch has not ended yet")]
    EpochNotEnded,
    #[msg("Recipient does not match")]
    InvalidRecipient,
    #[msg("Solution claim period has expired (500 epochs)")]
    ClaimExpired,
    #[msg("Solution has not expired yet")]
    NotExpired,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Nothing to withdraw")]
    NothingToWithdraw,
}
