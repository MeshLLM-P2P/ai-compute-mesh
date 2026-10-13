//! MeshLLM per-call USDT escrow program.
//!
//! Implements the exact state machine of the server-side simulated ledger
//! (`server/src/escrow.js`), which is the reference for the v1 demo:
//!
//!   EMPTY --fund--> FUNDED --beginCall--> IN_CALL --submitReceipt--> SETTLE_WINDOW
//!   SETTLE_WINDOW --settleFast (dual sig) | settleWindow (provider, after 60s)--> SETTLED
//!   IN_CALL --cancel (consumer, immediate) | refund (consumer, after 300s)--> FUNDED
//!   IN_CALL | SETTLE_WINDOW --dispute--> DISPUTED --resolve (dual sig)--> FUNDED | SETTLED
//!   FUNDED --withdraw--> EMPTY
//!
//! All amounts are integer micro-USDT. The fee is ALWAYS recomputed on-chain
//! from the listing pricing passed with the instruction (clients are never
//! trusted with the amount). Receipt / dispute resolutions are bound to a
//! canonical digest `digest = sha256(canonical(receipt payload))` computed
//! off-chain by both parties; the on-chain program verifies the Ed25519
//! signatures over `digest` via the Solana ed25519 verify program (CPI).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::system_program::System;
use anchor_spl::associated_token::{get_associated_token_address, AssociatedToken};
use anchor_spl::token;
use anchor_spl::token::{Mint, TokenAccount, Transfer};

// Placeholder: replace with the deployed program id after `anchor build`.
declare_id!("11111111111111111111111111111111");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

pub const STATE_EMPTY: u8 = 0;
pub const STATE_FUNDED: u8 = 1;
pub const STATE_IN_CALL: u8 = 2;
pub const STATE_SETTLE_WINDOW: u8 = 3;
pub const STATE_DISPUTED: u8 = 4;
pub const STATE_SETTLED: u8 = 5;

pub const SETTLE_WINDOW_SECONDS: i64 = 60;
pub const CALL_TIMEOUT_SECONDS: i64 = 300;

/// Solana ed25519 signature verify program (`solana_curve25519_program`).
const ED25519_VERIFY_ID: Pubkey =
    Pubkey::new_from_array(*b"Ed25519SigVerify1111111111111111");

// ---------------------------------------------------------------------------
// State types
// ---------------------------------------------------------------------------

/// Canonical receipt, signed by the provider wallet over
/// `sha256(canonical({listingId, sessionId, transcriptHash, tokensIn, tokensOut, ts}))`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace)]
pub struct Receipt {
    pub listing_id: [u8; 32],
    pub session_id: [u8; 32],
    pub transcript_hash: [u8; 32],
    pub tokens_in: u32,
    pub tokens_out: u32,
    pub ts: i64,
    /// Provider wallet signature (64-byte detached Ed25519) over the digest.
    pub signature: [u8; 64],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace)]
pub struct Dispute {
    pub by_consumer: bool,
    pub frozen_raw: u64,
    pub ts: i64,
}

#[account]
#[derive(InitSpace)]
pub struct Escrow {
    pub bump: u8,
    pub consumer: Pubkey,
    pub provider: Pubkey,
    pub listing_id: [u8; 32],
    pub state: u8,
    pub balance_raw: u64,
    pub total_calls: u32,
    pub total_settled_raw: u64,
    pub total_refunded_raw: u64,
    pub total_withdrawn_raw: u64,
    pub window_started_at: i64,
    /// sha256(session uuid string) while in a call; zero otherwise.
    pub call_session_id: [u8; 32],
    pub call_ts: i64,
    pub receipt: Option<Receipt>,
    pub dispute: Option<Dispute>,
    pub last_event: i64,
}

#[account]
#[derive(InitSpace)]
pub struct Bond {
    pub bump: u8,
    pub provider: Pubkey,
    pub listing_id: [u8; 32],
    pub balance_raw: u64,
}

/// Listing pricing (passed with settlement instructions; the program
/// recomputes the fee from it and the receipt token counts).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
pub struct Pricing {
    pub per1k_input_raw: u64,
    pub per1k_output_raw: u64,
    pub min_fee_raw: u64,
}

fn calc_amount_raw(p: &Pricing, tokens_in: u32, tokens_out: u32) -> u64 {
    let div_ceil = |a: u64, b: u64| (a + b - 1) / b;
    let in_fee = div_ceil(tokens_in as u64 * p.per1k_input_raw, 1000);
    let out_fee = div_ceil(tokens_out as u64 * p.per1k_output_raw, 1000);
    p.min_fee_raw.max(in_fee + out_fee)
}

/// Verify an Ed25519 signature over `msg` with the Solana verify program.
fn verify_ed25519(pk: &Pubkey, sig: &[u8; 64], msg: &[u8; 32]) -> Result<()> {
    // VerifyInstructions::VerifyPkAndSig, discriminator 0:
    //   pk: [u8;32], sig: [u8;64], msg_len: u32, msg: [u8]
    let mut data = Vec::with_capacity(1 + 32 + 64 + 4 + 32);
    data.push(0u8);
    data.extend_from_slice(pk.as_ref());
    data.extend_from_slice(sig);
    data.extend_from_slice(&(32u32).to_le_bytes());
    data.extend_from_slice(msg);
    let ix = Instruction {
        program_id: ED25519_VERIFY_ID,
        accounts: Vec::new(),
        data,
    };
    anchor_lang::solana_program::program::invoke(&ix, &[])
        .map_err(|e| anchor_lang::error::Error::from(e))?;
    Ok(())
}

fn now_ts() -> Result<i64> {
    Ok(Clock::get()?.unix_timestamp)
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct Fund<'info> {
    #[account(mut)]
    pub consumer: Signer<'info>,
    #[account(
        init,
        payer = consumer,
        seeds = [b"escrow", consumer.key().as_ref(), listing_id.key().as_ref()],
        bump,
        space = Escrow::INIT_SPACE
    )]
    pub escrow: Account<'info, Escrow>,
    #[account(
        init,
        payer = consumer,
        associated_token::authority = escrow,
        associated_token::mint = usdt_mint
    )]
    pub escrow_tokens: Account<'info, TokenAccount>,
    #[account(mut, associated_token::authority = consumer, associated_token::mint = usdt_mint)]
    pub consumer_ata: Account<'info, TokenAccount>,
    pub usdt_mint: Account<'info, Mint>,
    pub token_program: AccountInfo<'info>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub listing_id: UncheckedAccount<'info>,
    /// Provider wallet for this listing (from the directory; binding happens
    /// when the provider signs the first receipt).
    pub provider: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct BeginCall<'info> {
    pub consumer: Signer<'info>,
    #[account(mut, seeds = [b"escrow", consumer.key().as_ref(), listing_id.key().as_ref()], bump, has_one = consumer)]
    pub escrow: Account<'info, Escrow>,
    pub listing_id: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct SubmitReceipt<'info> {
    pub consumer: Signer<'info>,
    #[account(mut, seeds = [b"escrow", consumer.key().as_ref(), listing_id.key().as_ref()], bump, has_one = consumer)]
    pub escrow: Account<'info, Escrow>,
    pub listing_id: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct SettleFast<'info> {
    pub consumer: Signer<'info>,
    #[account(mut, seeds = [b"escrow", consumer.key().as_ref(), listing_id.key().as_ref()], bump, has_one = consumer)]
    pub escrow: Account<'info, Escrow>,
    #[account(mut, associated_token::authority = escrow, associated_token::mint = usdt_mint)]
    pub escrow_tokens: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = provider_ata.mint == usdt_mint.key()
            && provider_ata.owner == provider.key()
            && provider_ata.key() == get_associated_token_address(&provider.key(), &usdt_mint.key())
    )]
    pub provider_ata: Account<'info, TokenAccount>,
    #[account(constraint = provider.key() == escrow.provider)]
    pub provider: UncheckedAccount<'info>,
    pub usdt_mint: Account<'info, Mint>,
    pub token_program: AccountInfo<'info>,
    pub listing_id: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct SettleWindow<'info> {
    pub provider: Signer<'info>,
    #[account(mut, seeds = [b"escrow", consumer.key().as_ref(), listing_id.key().as_ref()], bump, has_one = provider)]
    pub escrow: Account<'info, Escrow>,
    #[account(mut, associated_token::authority = escrow, associated_token::mint = usdt_mint)]
    pub escrow_tokens: Account<'info, TokenAccount>,
    #[account(mut, associated_token::authority = provider, associated_token::mint = usdt_mint)]
    pub provider_ata: Account<'info, TokenAccount>,
    pub usdt_mint: Account<'info, Mint>,
    pub token_program: AccountInfo<'info>,
    pub listing_id: UncheckedAccount<'info>,
    pub consumer: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Refund<'info> {
    pub consumer: Signer<'info>,
    #[account(mut, seeds = [b"escrow", consumer.key().as_ref(), listing_id.key().as_ref()], bump, has_one = consumer)]
    pub escrow: Account<'info, Escrow>,
    #[account(mut, associated_token::authority = escrow, associated_token::mint = usdt_mint)]
    pub escrow_tokens: Account<'info, TokenAccount>,
    #[account(mut, associated_token::authority = consumer, associated_token::mint = usdt_mint)]
    pub consumer_ata: Account<'info, TokenAccount>,
    pub usdt_mint: Account<'info, Mint>,
    pub token_program: AccountInfo<'info>,
    pub listing_id: UncheckedAccount<'info>,
}

/// Same accounts as [`Refund`] — `cancel` is its immediate (no-timeout)
/// counterpart, usable while the call is still IN_CALL.
#[derive(Accounts)]
pub struct Cancel<'info> {
    pub consumer: Signer<'info>,
    #[account(mut, seeds = [b"escrow", consumer.key().as_ref(), listing_id.key().as_ref()], bump, has_one = consumer)]
    pub escrow: Account<'info, Escrow>,
    #[account(mut, associated_token::authority = escrow, associated_token::mint = usdt_mint)]
    pub escrow_tokens: Account<'info, TokenAccount>,
    #[account(mut, associated_token::authority = consumer, associated_token::mint = usdt_mint)]
    pub consumer_ata: Account<'info, TokenAccount>,
    pub usdt_mint: Account<'info, Mint>,
    pub token_program: AccountInfo<'info>,
    pub listing_id: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct DisputeIxs<'info> {
    pub consumer: Signer<'info>,
    #[account(mut, seeds = [b"escrow", consumer.key().as_ref(), listing_id.key().as_ref()], bump, has_one = consumer)]
    pub escrow: Account<'info, Escrow>,
    #[account(constraint = provider.key() == escrow.provider)]
    pub provider: UncheckedAccount<'info>,
    pub listing_id: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Resolve<'info> {
    pub consumer: Signer<'info>,
    #[account(mut, seeds = [b"escrow", consumer.key().as_ref(), listing_id.key().as_ref()], bump, has_one = consumer)]
    pub escrow: Account<'info, Escrow>,
    #[account(mut, associated_token::authority = escrow, associated_token::mint = usdt_mint)]
    pub escrow_tokens: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = provider_ata.mint == usdt_mint.key()
            && provider_ata.owner == provider.key()
            && provider_ata.key() == get_associated_token_address(&provider.key(), &usdt_mint.key())
    )]
    pub provider_ata: Account<'info, TokenAccount>,
    #[account(constraint = provider.key() == escrow.provider)]
    pub provider: UncheckedAccount<'info>,
    pub usdt_mint: Account<'info, Mint>,
    pub token_program: AccountInfo<'info>,
    pub listing_id: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub consumer: Signer<'info>,
    #[account(mut, seeds = [b"escrow", consumer.key().as_ref(), listing_id.key().as_ref()], bump, has_one = consumer)]
    pub escrow: Account<'info, Escrow>,
    #[account(mut, associated_token::authority = escrow, associated_token::mint = usdt_mint)]
    pub escrow_tokens: Account<'info, TokenAccount>,
    #[account(mut, associated_token::authority = consumer, associated_token::mint = usdt_mint)]
    pub consumer_ata: Account<'info, TokenAccount>,
    pub usdt_mint: Account<'info, Mint>,
    pub token_program: AccountInfo<'info>,
    pub listing_id: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct PostBond<'info> {
    #[account(mut)]
    pub provider: Signer<'info>,
    #[account(
        init,
        payer = provider,
        seeds = [b"bond", provider.key().as_ref(), listing_id.key().as_ref()],
        bump,
        space = Bond::INIT_SPACE
    )]
    pub bond: Account<'info, Bond>,
    #[account(
        init,
        payer = provider,
        associated_token::authority = bond,
        associated_token::mint = usdt_mint
    )]
    pub bond_tokens: Account<'info, TokenAccount>,
    #[account(mut, associated_token::authority = provider, associated_token::mint = usdt_mint)]
    pub provider_ata: Account<'info, TokenAccount>,
    pub usdt_mint: Account<'info, Mint>,
    pub token_program: AccountInfo<'info>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub listing_id: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Slash<'info> {
    pub provider: Signer<'info>,
    #[account(mut, seeds = [b"bond", provider.key().as_ref(), listing_id.key().as_ref()], bump, has_one = provider)]
    pub bond: Account<'info, Bond>,
    #[account(mut, associated_token::authority = bond, associated_token::mint = usdt_mint)]
    pub bond_tokens: Account<'info, TokenAccount>,
    #[account(mut, constraint = slashed_to.mint == usdt_mint.key())]
    pub slashed_to: Account<'info, TokenAccount>,
    pub usdt_mint: Account<'info, Mint>,
    pub token_program: AccountInfo<'info>,
    pub listing_id: UncheckedAccount<'info>,
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

#[program]
pub mod mesh_escrow {
    use super::*;

    // EMPTY | FUNDED -> FUNDED. Moves `amount_raw` micro-USDT into escrow.
    pub fn fund(ctx: Context<Fund>, amount_raw: u64) -> Result<()> {
        require!(amount_raw > 0, ErrorCode::BadAmount);
        let escrow = &mut ctx.accounts.escrow;
        escrow.consumer = ctx.accounts.consumer.key();
        escrow.provider = ctx.accounts.provider.key();
        escrow.listing_id = ctx.accounts.listing_id.key().to_bytes();
        escrow.state = STATE_FUNDED;
        escrow.balance_raw = escrow.balance_raw + amount_raw;
        escrow.last_event = now_ts()?;
        let cpi_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.consumer_ata.to_account_info(),
                to: ctx.accounts.escrow_tokens.to_account_info(),
                authority: ctx.accounts.consumer.to_account_info(),
            },
        );
        // Consumer signs the token transfer (they are the real signer).
        token::transfer(cpi_ctx, amount_raw)?;
        Ok(())
    }

    // FUNDED -> IN_CALL.
    pub fn begin_call(ctx: Context<BeginCall>, session_id: [u8; 32]) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(escrow.state == STATE_FUNDED, ErrorCode::BadState);
        require!(session_id.iter().any(|b| *b != 0), ErrorCode::SessionRequired);
        escrow.state = STATE_IN_CALL;
        escrow.call_session_id = session_id;
        escrow.call_ts = now_ts()?;
        escrow.last_event = escrow.call_ts;
        Ok(())
    }

    // IN_CALL -> SETTLE_WINDOW. Verifies the provider signature over the
    // canonical receipt digest (CPI to the ed25519 verify program).
    pub fn submit_receipt(
        ctx: Context<SubmitReceipt>,
        receipt: Receipt,
        digest: [u8; 32],
        provider_pubkey: Pubkey,
    ) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(escrow.state == STATE_IN_CALL, ErrorCode::BadState);
        require!(receipt.listing_id == escrow.listing_id, ErrorCode::ReceiptMismatch);
        require!(receipt.session_id == escrow.call_session_id, ErrorCode::SessionMismatch);
        require!(
            receipt.listing_id == ctx.accounts.listing_id.key().to_bytes(),
            ErrorCode::ReceiptMismatch
        );
        verify_ed25519(&provider_pubkey, &receipt.signature, &digest)?;
        require_keys_eq!(provider_pubkey, escrow.provider, ErrorCode::ProviderMismatch);
        escrow.receipt = Some(receipt);
        escrow.state = STATE_SETTLE_WINDOW;
        escrow.window_started_at = now_ts()?;
        escrow.last_event = escrow.window_started_at;
        Ok(())
    }

    // SETTLE_WINDOW -> SETTLED. Both parties sign the receipt digest.
    pub fn settle_fast(
        ctx: Context<SettleFast>,
        consumer_sig: [u8; 64],
        provider_sig: [u8; 64],
        digest: [u8; 32],
        pricing: Pricing,
    ) -> Result<()> {
        let consumer_key = ctx.accounts.consumer.key();
        let listing_key = ctx.accounts.listing_id.key();
        let escrow_info = ctx.accounts.escrow.to_account_info();
        let escrow = &mut ctx.accounts.escrow;
        require!(escrow.state == STATE_SETTLE_WINDOW, ErrorCode::BadState);
        let receipt = match escrow.receipt {
            Some(r) => r,
            None => return err!(ErrorCode::NoReceipt),
        };
        verify_ed25519(&consumer_key, &consumer_sig, &digest)?;
        verify_ed25519(&escrow.provider, &provider_sig, &digest)?;
        let amount = calc_amount_raw(&pricing, receipt.tokens_in, receipt.tokens_out);
        require!(amount <= escrow.balance_raw, ErrorCode::InsufficientBalance);
        let seeds = [
            b"escrow",
            consumer_key.as_ref(),
            listing_key.as_ref(),
            &[escrow.bump],
        ];
        let signer_seeds: [&[&[u8]]; 1] = [&seeds];
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.escrow_tokens.to_account_info(),
                to: ctx.accounts.provider_ata.to_account_info(),
                authority: escrow_info,
            },
            &signer_seeds,
        );
        escrow.balance_raw = escrow.balance_raw - amount;
        escrow.total_settled_raw = escrow.total_settled_raw + amount;
        escrow.total_calls = escrow.total_calls + 1;
        escrow.state = STATE_SETTLED;
        escrow.last_event = now_ts()?;
        token::transfer(cpi_ctx, amount)?;
        Ok(())
    }

    // SETTLE_WINDOW -> SETTLED, provider alone, after the window elapses.
    pub fn settle_window(
        ctx: Context<SettleWindow>,
        provider_sig: [u8; 64],
        digest: [u8; 32],
        pricing: Pricing,
    ) -> Result<()> {
        let consumer_key = ctx.accounts.consumer.key();
        let listing_key = ctx.accounts.listing_id.key();
        let escrow_info = ctx.accounts.escrow.to_account_info();
        let escrow = &mut ctx.accounts.escrow;
        require!(escrow.state == STATE_SETTLE_WINDOW, ErrorCode::BadState);
        require_keys_eq!(ctx.accounts.provider.key(), escrow.provider, ErrorCode::ProviderMismatch);
        let now = now_ts()?;
        require!(
            now - escrow.window_started_at >= SETTLE_WINDOW_SECONDS,
            ErrorCode::WindowNotElapsed
        );
        let receipt = match escrow.receipt {
            Some(r) => r,
            None => return err!(ErrorCode::NoReceipt),
        };
        verify_ed25519(&escrow.provider, &provider_sig, &digest)?;
        let amount = calc_amount_raw(&pricing, receipt.tokens_in, receipt.tokens_out);
        require!(amount <= escrow.balance_raw, ErrorCode::InsufficientBalance);
        let seeds = [
            b"escrow",
            consumer_key.as_ref(),
            listing_key.as_ref(),
            &[escrow.bump],
        ];
        let signer_seeds: [&[&[u8]]; 1] = [&seeds];
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.escrow_tokens.to_account_info(),
                to: ctx.accounts.provider_ata.to_account_info(),
                authority: escrow_info,
            },
            &signer_seeds,
        );
        escrow.balance_raw = escrow.balance_raw - amount;
        escrow.total_settled_raw = escrow.total_settled_raw + amount;
        escrow.total_calls = escrow.total_calls + 1;
        escrow.state = STATE_SETTLED;
        escrow.last_event = now;
        token::transfer(cpi_ctx, amount)?;
        Ok(())
    }

    // IN_CALL -> FUNDED, consumer side, after the call timeout.
    pub fn refund(ctx: Context<Refund>) -> Result<()> {
        let consumer_key = ctx.accounts.consumer.key();
        let listing_key = ctx.accounts.listing_id.key();
        let escrow_info = ctx.accounts.escrow.to_account_info();
        let escrow = &mut ctx.accounts.escrow;
        require!(escrow.state == STATE_IN_CALL, ErrorCode::BadState);
        let now = now_ts()?;
        require!(
            now - escrow.call_ts >= CALL_TIMEOUT_SECONDS,
            ErrorCode::CallNotTimedOut
        );
        let amount = escrow.balance_raw;
        let seeds = [
            b"escrow",
            consumer_key.as_ref(),
            listing_key.as_ref(),
            &[escrow.bump],
        ];
        let signer_seeds: [&[&[u8]]; 1] = [&seeds];
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.escrow_tokens.to_account_info(),
                to: ctx.accounts.consumer_ata.to_account_info(),
                authority: escrow_info,
            },
            &signer_seeds,
        );
        escrow.state = STATE_FUNDED;
        escrow.call_session_id = [0u8; 32];
        escrow.call_ts = 0;
        escrow.total_refunded_raw = escrow.total_refunded_raw + amount;
        escrow.last_event = now;
        token::transfer(cpi_ctx, amount)?;
        Ok(())
    }

    // IN_CALL -> FUNDED, consumer side, immediately (no timeout required).
    // Safe while IN_CALL: no receipt has been submitted, so nothing is owed
    // to the provider. `refund` is the passive 300s-timeout counterpart.
    pub fn cancel(ctx: Context<Cancel>) -> Result<()> {
        let consumer_key = ctx.accounts.consumer.key();
        let listing_key = ctx.accounts.listing_id.key();
        let escrow_info = ctx.accounts.escrow.to_account_info();
        let escrow = &mut ctx.accounts.escrow;
        require!(escrow.state == STATE_IN_CALL, ErrorCode::BadState);
        let now = now_ts()?;
        let amount = escrow.balance_raw;
        let seeds = [
            b"escrow",
            consumer_key.as_ref(),
            listing_key.as_ref(),
            &[escrow.bump],
        ];
        let signer_seeds: [&[&[u8]]; 1] = [&seeds];
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.escrow_tokens.to_account_info(),
                to: ctx.accounts.consumer_ata.to_account_info(),
                authority: escrow_info,
            },
            &signer_seeds,
        );
        escrow.state = STATE_FUNDED;
        escrow.call_session_id = [0u8; 32];
        escrow.call_ts = 0;
        escrow.total_refunded_raw = escrow.total_refunded_raw + amount;
        escrow.last_event = now;
        token::transfer(cpi_ctx, amount)?;
        Ok(())
    }

     // IN_CALL | SETTLE_WINDOW -> DISPUTED. Either party may open a dispute;
    // the full balance is frozen until `resolve`.
    pub fn dispute(ctx: Context<DisputeIxs>, by_consumer: bool, reason_len: u8) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(
            escrow.state == STATE_IN_CALL || escrow.state == STATE_SETTLE_WINDOW,
            ErrorCode::BadState
        );
        if !by_consumer {
            // provider-initiated dispute: the provider wallet must be a signer
            require!(ctx.accounts.provider.is_signer, ErrorCode::ActorNotSigner);
        }
        escrow.dispute = Some(Dispute {
            by_consumer,
            frozen_raw: escrow.balance_raw,
            ts: now_ts()?,
        });
        escrow.state = STATE_DISPUTED;
        emit!(DisputeOpened {
            consumer: escrow.consumer,
            listing_id: ctx.accounts.listing_id.key().to_bytes(),
            by_consumer,
            reason_len,
            frozen_raw: escrow.dispute.as_ref().unwrap().frozen_raw,
        });
        Ok(())
    }

    // DISPUTED -> FUNDED | SETTLED. `refund_raw` returns to the consumer,
    // the remainder pays the provider. Both parties sign the receipt digest.
    pub fn resolve(
        ctx: Context<Resolve>,
        refund_raw: u64,
        consumer_sig: [u8; 64],
        provider_sig: [u8; 64],
        digest: [u8; 32],
    ) -> Result<()> {
        let consumer_key = ctx.accounts.consumer.key();
        let listing_key = ctx.accounts.listing_id.key();
        let escrow_info = ctx.accounts.escrow.to_account_info();
        let escrow = &mut ctx.accounts.escrow;
        require!(escrow.state == STATE_DISPUTED, ErrorCode::BadState);
        let dispute = match escrow.dispute {
            Some(d) => d,
            None => return err!(ErrorCode::NoDispute),
        };
        require!(escrow.receipt.is_some(), ErrorCode::NoReceipt);
        require!(refund_raw <= dispute.frozen_raw, ErrorCode::RefundExceedsFrozen);
        verify_ed25519(&consumer_key, &consumer_sig, &digest)?;
        verify_ed25519(&escrow.provider, &provider_sig, &digest)?;
        let pay_raw = dispute.frozen_raw - refund_raw;
        if pay_raw > 0 {
            let seeds = [
                b"escrow",
                consumer_key.as_ref(),
                listing_key.as_ref(),
                &[escrow.bump],
            ];
            let signer_seeds: [&[&[u8]]; 1] = [&seeds];
        let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.escrow_tokens.to_account_info(),
                    to: ctx.accounts.provider_ata.to_account_info(),
                    authority: escrow_info,
                },
                &signer_seeds,
            );
            escrow.total_settled_raw = escrow.total_settled_raw + pay_raw;
            token::transfer(cpi_ctx, pay_raw)?;
        }
        escrow.balance_raw = refund_raw;
        escrow.total_calls = escrow.total_calls + 1;
        escrow.state = if refund_raw > 0 { STATE_FUNDED } else { STATE_SETTLED };
        escrow.dispute = None;
        escrow.last_event = now_ts()?;
        Ok(())
    }

    // FUNDED -> EMPTY. Consumer withdraws the whole balance.
    pub fn withdraw(ctx: Context<Withdraw>) -> Result<()> {
        let consumer_key = ctx.accounts.consumer.key();
        let listing_key = ctx.accounts.listing_id.key();
        let escrow_info = ctx.accounts.escrow.to_account_info();
        let escrow = &mut ctx.accounts.escrow;
        require!(escrow.state == STATE_FUNDED, ErrorCode::BadState);
        require!(escrow.balance_raw > 0, ErrorCode::NothingToWithdraw);
        let amount = escrow.balance_raw;
        let seeds = [
            b"escrow",
            consumer_key.as_ref(),
            listing_key.as_ref(),
            &[escrow.bump],
        ];
        let signer_seeds: [&[&[u8]]; 1] = [&seeds];
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.escrow_tokens.to_account_info(),
                to: ctx.accounts.consumer_ata.to_account_info(),
                authority: escrow_info,
            },
            &signer_seeds,
        );
        escrow.balance_raw = 0;
        escrow.total_withdrawn_raw = escrow.total_withdrawn_raw + amount;
        escrow.state = STATE_EMPTY;
        escrow.last_event = now_ts()?;
        token::transfer(cpi_ctx, amount)?;
        Ok(())
    }

    // Provider posts bond for a listing (v1: voluntary, mirrored on-chain).
    pub fn post_bond(ctx: Context<PostBond>, amount_raw: u64) -> Result<()> {
        require!(amount_raw > 0, ErrorCode::BadAmount);
        let bond = &mut ctx.accounts.bond;
        bond.provider = ctx.accounts.provider.key();
        bond.listing_id = ctx.accounts.listing_id.key().to_bytes();
        bond.balance_raw = amount_raw;
        let cpi_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.provider_ata.to_account_info(),
                to: ctx.accounts.bond_tokens.to_account_info(),
                authority: ctx.accounts.provider.to_account_info(),
            },
        );
        token::transfer(cpi_ctx, amount_raw)?;
        Ok(())
    }

    // v1: provider-consented partial slash (destination = arbitrator ATA).
    // Non-consensual slashing requires the v2 arbitration program.
    pub fn slash(ctx: Context<Slash>, amount_raw: u64) -> Result<()> {
        let provider_key = ctx.accounts.provider.key();
        let listing_key = ctx.accounts.listing_id.key();
        let bond_info = ctx.accounts.bond.to_account_info();
        let bond = &mut ctx.accounts.bond;
        require!(amount_raw > 0 && amount_raw <= bond.balance_raw, ErrorCode::BadAmount);
        let seeds = [
            b"bond",
            provider_key.as_ref(),
            listing_key.as_ref(),
            &[bond.bump],
        ];
        let signer_seeds: [&[&[u8]]; 1] = [&seeds];
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.bond_tokens.to_account_info(),
                to: ctx.accounts.slashed_to.to_account_info(),
                authority: bond_info,
            },
            &signer_seeds,
        );
        bond.balance_raw = bond.balance_raw - amount_raw;
        token::transfer(cpi_ctx, amount_raw)?;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Errors / events
// ---------------------------------------------------------------------------

#[error_code]
pub enum ErrorCode {
    #[msg("bad amount")]
    BadAmount,
    #[msg("state does not allow this operation")]
    BadState,
    #[msg("session id required")]
    SessionRequired,
    #[msg("receipt does not match listing")]
    ReceiptMismatch,
    #[msg("receipt session does not match active call")]
    SessionMismatch,
    #[msg("provider mismatch")]
    ProviderMismatch,
    #[msg("no receipt on this escrow")]
    NoReceipt,
    #[msg("no dispute on this escrow")]
    NoDispute,
    #[msg("insufficient escrow balance")]
    InsufficientBalance,
    #[msg("settle window has not elapsed")]
    WindowNotElapsed,
    #[msg("call has not timed out")]
    CallNotTimedOut,
    #[msg("actor is not a signer of this transaction")]
    ActorNotSigner,
    #[msg("refund exceeds frozen amount")]
    RefundExceedsFrozen,
    #[msg("nothing to withdraw")]
    NothingToWithdraw,
}

#[event]
pub struct DisputeOpened {
    pub consumer: Pubkey,
    pub listing_id: [u8; 32],
    pub by_consumer: bool,
    pub reason_len: u8,
    pub frozen_raw: u64,
}
