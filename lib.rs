use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program::invoke_signed, instruction::Instruction};
use anchor_spl::token::{self, Token, TokenAccount, Mint, Transfer, SyncNative};
use anchor_spl::associated_token::AssociatedToken;

declare_id!("perpmwcaoweY2WNxviUKrJPCAvLaNHGESXZGZgiDVDS");

// === Constants ===

const PUMPSWAP_PROGRAM_ID: Pubkey = pubkey!("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const WSOL_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");

const MAX_LEVERAGE: u64 = 10;
const LIQUIDATION_THRESHOLD_BPS: u64 = 7000;
const LIQUIDATOR_REWARD_BPS: u64 = 500;
const PROTOCOL_FEE_BPS: u64 = 30;
const BPS_DENOMINATOR: u64 = 10_000;
const PRECISION: u128 = 1_000_000_000_000;

const POOL_BASE_MINT_OFFSET: usize = 43;
const TOKEN_AMOUNT_OFFSET: usize = 64;

const BUY_DISCRIMINATOR: [u8; 8] = [102, 6, 61, 18, 1, 218, 235, 234];
const SELL_DISCRIMINATOR: [u8; 8] = [51, 230, 133, 164, 1, 127, 131, 173];

#[program]
pub mod perpe {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let protocol = &mut ctx.accounts.protocol;
        protocol.admin = ctx.accounts.admin.key();
        protocol.bump = ctx.bumps.protocol;
        protocol.vault_bump = ctx.bumps.protocol_vault;
        
        emit!(ProtocolInitialized { admin: protocol.admin });
        Ok(())
    }
    pub fn create_market(ctx: Context<CreateMarket>, max_position_size: u64) -> Result<()> {
        require!(
            ctx.accounts.admin.key() == ctx.accounts.protocol.admin,
            ErrorCode::Unauthorized
        );
    
        require!(
            ctx.accounts.pumpswap_pool.owner == &PUMPSWAP_PROGRAM_ID,
            ErrorCode::InvalidPool
        );
    
        let pool_data = ctx.accounts.pumpswap_pool.try_borrow_data()?;
        let base_mint = Pubkey::try_from(&pool_data[POOL_BASE_MINT_OFFSET..POOL_BASE_MINT_OFFSET + 32])
            .map_err(|_| ErrorCode::InvalidPool)?;
        require!(base_mint == ctx.accounts.token_mint.key(), ErrorCode::PoolMintMismatch);
        drop(pool_data);
    
        let market = &mut ctx.accounts.market;
        market.token_mint = ctx.accounts.token_mint.key();
        market.pumpswap_pool = ctx.accounts.pumpswap_pool.key();
        market.total_long_collateral = 0;
        market.total_short_collateral = 0;
        market.total_positions = 0;
        market.max_position_size = max_position_size;  // NEW
        market.bump = ctx.bumps.market;

        let lending = &mut ctx.accounts.lending_pool;
        lending.market = market.key();
        lending.token_mint = ctx.accounts.token_mint.key();
        lending.total_deposits = 0;
        lending.total_borrowed = 0;
        lending.total_shares = 0;
        lending.bump = ctx.bumps.lending_pool;

        emit!(MarketCreated {
            token_mint: market.token_mint,
            pumpswap_pool: market.pumpswap_pool,
            max_position_size,  // NEW
        });
    
        Ok(())
    }

    pub fn create_wsol_vault(_ctx: Context<CreateWsolVault>) -> Result<()> {
        Ok(())
    }

    pub fn unwrap_wsol(ctx: Context<UnwrapWsol>) -> Result<()> {
        let vault_bump = ctx.accounts.protocol.vault_bump;
        let seeds: &[&[u8]] = &[b"protocol_vault", &[vault_bump]];
        let signer_seeds = &[seeds];
    
        token::close_account(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::CloseAccount {
                    account: ctx.accounts.wsol_vault.to_account_info(),
                    destination: ctx.accounts.protocol_vault.to_account_info(),
                    authority: ctx.accounts.protocol_vault.to_account_info(),
                },
                signer_seeds,
            ),
        )?;
    
        Ok(())
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, ErrorCode::ZeroAmount);

        // Transfer SOL to protocol_vault
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.user.to_account_info(),
                    to: ctx.accounts.protocol_vault.to_account_info(),
                },
            ),
            amount,
        )?;

        // Update user's balance record
        let user_account = &mut ctx.accounts.user_account;
        user_account.owner = ctx.accounts.user.key();
        user_account.balance = user_account.balance.checked_add(amount).ok_or(ErrorCode::Overflow)?;
        user_account.bump = ctx.bumps.user_account;

        emit!(Deposited {
            user: ctx.accounts.user.key(),
            amount,
            new_balance: user_account.balance,
        });

        Ok(())
    }

    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        require!(ctx.accounts.user_account.balance >= amount, ErrorCode::InsufficientBalance);

        let new_balance = ctx.accounts.user_account.balance.checked_sub(amount).ok_or(ErrorCode::Overflow)?;
        ctx.accounts.user_account.balance = new_balance;

        // Transfer SOL from protocol_vault to user
        let vault_bump = ctx.accounts.protocol.vault_bump;
        let seeds: &[&[u8]] = &[b"protocol_vault", &[vault_bump]];
        let signer_seeds = &[seeds];

        anchor_lang::system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.protocol_vault.to_account_info(),
                    to: ctx.accounts.user.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
        )?;

        emit!(Withdrawn {
            user: ctx.accounts.user.key(),
            amount,
            new_balance,
        });

        Ok(())
    }

    pub fn deposit_to_lending(ctx: Context<DepositToLending>, amount: u64) -> Result<()> {
        require!(amount > 0, ErrorCode::ZeroAmount);

        let lending = &mut ctx.accounts.lending_pool;

        let shares = if lending.total_deposits == 0 {
            amount
        } else {
            (amount as u128)
                .checked_mul(lending.total_shares as u128)
                .ok_or(ErrorCode::Overflow)?
                .checked_div(lending.total_deposits as u128)
                .ok_or(ErrorCode::Overflow)? as u64
        };

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_token_account.to_account_info(),
                    to: ctx.accounts.token_vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount,
        )?;

        lending.total_deposits = lending.total_deposits.checked_add(amount).ok_or(ErrorCode::Overflow)?;
        lending.total_shares = lending.total_shares.checked_add(shares).ok_or(ErrorCode::Overflow)?;

        let lender = &mut ctx.accounts.lender_position;
        lender.owner = ctx.accounts.user.key();
        lender.lending_pool = lending.key();
        lender.shares = lender.shares.checked_add(shares).ok_or(ErrorCode::Overflow)?;
        lender.bump = ctx.bumps.lender_position;

        emit!(LendingDeposited {
            user: ctx.accounts.user.key(),
            amount,
            shares,
        });

        Ok(())
    }

    pub fn withdraw_from_lending(ctx: Context<WithdrawFromLending>, shares: u64) -> Result<()> {
        let lender = &mut ctx.accounts.lender_position;
        require!(lender.shares >= shares, ErrorCode::InsufficientShares);

        let lending = &mut ctx.accounts.lending_pool;

        let tokens = (shares as u128)
            .checked_mul(lending.total_deposits as u128)
            .ok_or(ErrorCode::Overflow)?
            .checked_div(lending.total_shares as u128)
            .ok_or(ErrorCode::Overflow)? as u64;

        let available = lending.total_deposits.saturating_sub(lending.total_borrowed);
        require!(tokens <= available, ErrorCode::InsufficientLiquidity);

        let vault_bump = ctx.accounts.protocol.vault_bump;
        let seeds: &[&[u8]] = &[b"protocol_vault", &[vault_bump]];
        let signer_seeds = &[seeds];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.token_vault.to_account_info(),
                    to: ctx.accounts.user_token_account.to_account_info(),
                    authority: ctx.accounts.protocol_vault.to_account_info(),
                },
                signer_seeds,
            ),
            tokens,
        )?;

        lending.total_deposits = lending.total_deposits.saturating_sub(tokens);
        lending.total_shares = lending.total_shares.saturating_sub(shares);
        lender.shares = lender.shares.saturating_sub(shares);

        emit!(LendingWithdrawn {
            user: ctx.accounts.user.key(),
            tokens,
            shares,
        });

        Ok(())
    }

    pub fn open_position<'info>(
        ctx: Context<'_, '_, '_, 'info, OpenPosition<'info>>,
        is_long: bool,
        collateral: u64,
        leverage: u64,
        slippage_limit: u64,
    ) -> Result<()> {
        require!(leverage >= 1 && leverage <= MAX_LEVERAGE, ErrorCode::InvalidLeverage);
        require!(collateral > 0, ErrorCode::ZeroCollateral);
    
        let user_account = &mut ctx.accounts.user_account;
        require!(user_account.balance >= collateral, ErrorCode::InsufficientBalance);
    
        let fee = collateral * PROTOCOL_FEE_BPS / BPS_DENOMINATOR;
        let collateral_after_fee = collateral - fee;
        let position_size_sol = collateral_after_fee.checked_mul(leverage).ok_or(ErrorCode::Overflow)?;
    
        require!(
            position_size_sol <= ctx.accounts.market.max_position_size,
            ErrorCode::PositionTooLarge
        );

        // Parse pumpswap accounts from remaining_accounts
        let pump = parse_pumpswap_accounts(ctx.remaining_accounts)?;

        user_account.balance = user_account.balance.checked_sub(collateral).ok_or(ErrorCode::Overflow)?;

        let entry_price = get_pool_price(
            pump.pool_base_vault,
            pump.pool_quote_vault,
        )?;

        let position = &mut ctx.accounts.position;
        position.owner = ctx.accounts.user.key();
        position.market = ctx.accounts.market.key();
        position.is_long = is_long;
        position.collateral = collateral_after_fee;
        position.leverage = leverage;
        position.entry_price = entry_price;
        position.opened_at = Clock::get()?.unix_timestamp;
        position.bump = ctx.bumps.position;

        let vault_bump = ctx.accounts.protocol.vault_bump;

        if is_long {
            let tokens = execute_buy(
                &ctx.accounts.protocol_vault,
                &mut ctx.accounts.token_vault,
                &mut ctx.accounts.wsol_vault,
                pump.pumpswap_pool,
                pump.pool_base_vault,
                pump.pool_quote_vault,
                pump.pumpswap_global,
                &ctx.accounts.token_mint,
                &ctx.accounts.wsol_mint,
                pump.protocol_fee_recipient,
                pump.protocol_fee_recipient_ata,
                pump.coin_creator_vault_ata,
                pump.coin_creator_vault_authority,
                pump.global_volume_accumulator,
                pump.user_volume_accumulator,
                pump.fee_config,
                pump.fee_program,
                &ctx.accounts.token_program,
                pump.token_program_2022,
                &ctx.accounts.system_program,
                &ctx.accounts.associated_token_program,
                pump.event_authority,
                pump.pumpswap_program,
                vault_bump,
                position_size_sol,
                slippage_limit,
            )?;

            position.token_amount = tokens;
            position.position_size_sol = position_size_sol;
            position.borrowed_tokens = 0;
            position.liquidation_price = calc_liq_price_long(entry_price, leverage)?;

            let market = &mut ctx.accounts.market;
            market.total_long_collateral = market.total_long_collateral
                .checked_add(collateral_after_fee).ok_or(ErrorCode::Overflow)?;

        } else {
            let tokens_to_borrow = (position_size_sol as u128)
                .checked_mul(PRECISION)
                .ok_or(ErrorCode::Overflow)?
                .checked_div(entry_price as u128)
                .ok_or(ErrorCode::Overflow)? as u64;

            let lending = &mut ctx.accounts.lending_pool;
            let available = lending.total_deposits.saturating_sub(lending.total_borrowed);
            require!(tokens_to_borrow <= available, ErrorCode::InsufficientLiquidity);

            lending.total_borrowed = lending.total_borrowed
                .checked_add(tokens_to_borrow).ok_or(ErrorCode::Overflow)?;

            let sol_received = execute_sell(
                &ctx.accounts.protocol_vault,
                &mut ctx.accounts.token_vault,
                &mut ctx.accounts.wsol_vault,
                pump.pumpswap_pool,
                pump.pool_base_vault,
                pump.pool_quote_vault,
                pump.pumpswap_global,
                &ctx.accounts.token_mint,
                &ctx.accounts.wsol_mint,
                pump.protocol_fee_recipient,
                pump.protocol_fee_recipient_ata,
                pump.coin_creator_vault_ata,
                pump.coin_creator_vault_authority,
                pump.fee_config,
                pump.fee_program,
                &ctx.accounts.token_program,
                pump.token_program_2022,
                &ctx.accounts.system_program,
                &ctx.accounts.associated_token_program,
                pump.event_authority,
                pump.pumpswap_program,
                vault_bump,
                tokens_to_borrow,
                slippage_limit,
            )?;

            position.token_amount = 0;
            position.position_size_sol = sol_received;
            position.borrowed_tokens = tokens_to_borrow;
            position.liquidation_price = calc_liq_price_short(entry_price, leverage)?;

            let market = &mut ctx.accounts.market;
            market.total_short_collateral = market.total_short_collateral
                .checked_add(collateral_after_fee).ok_or(ErrorCode::Overflow)?;
        }

        let market = &mut ctx.accounts.market;
        market.total_positions += 1;

        emit!(PositionOpened {
            owner: position.owner,
            market: position.market,
            is_long,
            collateral: collateral_after_fee,
            leverage,
            entry_price,
            liquidation_price: position.liquidation_price,
        });

        Ok(())
    }

    pub fn close_position<'info>(
        ctx: Context<'_, '_, '_, 'info, ClosePosition<'info>>,
        slippage_limit: u64,
    ) -> Result<()> {
        let position = &ctx.accounts.position;
        
        // Parse pumpswap accounts from remaining_accounts
        let pump = parse_pumpswap_accounts(ctx.remaining_accounts)?;

        let current_price = get_pool_price(
            pump.pool_base_vault,
            pump.pool_quote_vault,
        )?;

        let vault_bump = ctx.accounts.protocol.vault_bump;
        let pnl: i64;
        let payout: u64;

        if position.is_long {
            let sol_received = execute_sell(
                &ctx.accounts.protocol_vault,
                &mut ctx.accounts.token_vault,
                &mut ctx.accounts.wsol_vault,
                pump.pumpswap_pool,
                pump.pool_base_vault,
                pump.pool_quote_vault,
                pump.pumpswap_global,
                &ctx.accounts.token_mint,
                &ctx.accounts.wsol_mint,
                pump.protocol_fee_recipient,
                pump.protocol_fee_recipient_ata,
                pump.coin_creator_vault_ata,
                pump.coin_creator_vault_authority,
                pump.fee_config,
                pump.fee_program,
                &ctx.accounts.token_program,
                pump.token_program_2022,
                &ctx.accounts.system_program,
                &ctx.accounts.associated_token_program,
                pump.event_authority,
                pump.pumpswap_program,
                vault_bump,
                position.token_amount,
                slippage_limit,
            )?;

            pnl = (sol_received as i64) - (position.position_size_sol as i64);
            
            let close_fee = position.collateral * PROTOCOL_FEE_BPS / BPS_DENOMINATOR;
            let payout_i64 = position.collateral as i64 + pnl - close_fee as i64;
            payout = if payout_i64 > 0 { payout_i64 as u64 } else { 0 };

            let market = &mut ctx.accounts.market;
            market.total_long_collateral = market.total_long_collateral
                .saturating_sub(position.collateral);

        } else {
            let tokens_to_buy = position.borrowed_tokens;

            let sol_spent = execute_buy_for_close(
                &ctx.accounts.protocol_vault,
                &mut ctx.accounts.token_vault,
                &mut ctx.accounts.wsol_vault,
                pump.pumpswap_pool,
                pump.pool_base_vault,
                pump.pool_quote_vault,
                pump.pumpswap_global,
                &ctx.accounts.token_mint,
                &ctx.accounts.wsol_mint,
                pump.protocol_fee_recipient,
                pump.protocol_fee_recipient_ata,
                pump.coin_creator_vault_ata,
                pump.coin_creator_vault_authority,
                pump.global_volume_accumulator,
                pump.user_volume_accumulator,
                pump.fee_config,
                pump.fee_program,
                &ctx.accounts.token_program,
                pump.token_program_2022,
                &ctx.accounts.system_program,
                &ctx.accounts.associated_token_program,
                pump.event_authority,
                pump.pumpswap_program,
                vault_bump,
                tokens_to_buy,
                slippage_limit,
            )?;

            let lending = &mut ctx.accounts.lending_pool;
            lending.total_borrowed = lending.total_borrowed.saturating_sub(position.borrowed_tokens);

            pnl = (position.position_size_sol as i64) - (sol_spent as i64);
            
            let close_fee = position.collateral * PROTOCOL_FEE_BPS / BPS_DENOMINATOR;
            let payout_i64 = position.collateral as i64 + pnl - close_fee as i64;
            payout = if payout_i64 > 0 { payout_i64 as u64 } else { 0 };

            let market = &mut ctx.accounts.market;
            market.total_short_collateral = market.total_short_collateral
                .saturating_sub(position.collateral);
        }

        let market = &mut ctx.accounts.market;
        market.total_positions = market.total_positions.saturating_sub(1);

        let user_account = &mut ctx.accounts.user_account;
        user_account.balance = user_account.balance.checked_add(payout).ok_or(ErrorCode::Overflow)?;

        emit!(PositionClosed {
            owner: position.owner,
            market: position.market,
            is_long: position.is_long,
            entry_price: position.entry_price,
            exit_price: current_price,
            pnl,
            payout,
        });

        Ok(())
    }

    pub fn liquidate<'info>(
        ctx: Context<'_, '_, '_, 'info, Liquidate<'info>>,
        slippage_limit: u64,
    ) -> Result<()> {
        let position = &ctx.accounts.position;

        // Parse pumpswap accounts from remaining_accounts
        let pump = parse_pumpswap_accounts(ctx.remaining_accounts)?;

        let current_price = get_pool_price(
            pump.pool_base_vault,
            pump.pool_quote_vault,
        )?;

        if position.is_long {
            require!(current_price <= position.liquidation_price, ErrorCode::NotLiquidatable);
        } else {
            require!(current_price >= position.liquidation_price, ErrorCode::NotLiquidatable);
        }

        let vault_bump = ctx.accounts.protocol.vault_bump;
        let remaining: u64;

        if position.is_long {
            let sol_received = execute_sell(
                &ctx.accounts.protocol_vault,
                &mut ctx.accounts.token_vault,
                &mut ctx.accounts.wsol_vault,
                pump.pumpswap_pool,
                pump.pool_base_vault,
                pump.pool_quote_vault,
                pump.pumpswap_global,
                &ctx.accounts.token_mint,
                &ctx.accounts.wsol_mint,
                pump.protocol_fee_recipient,
                pump.protocol_fee_recipient_ata,
                pump.coin_creator_vault_ata,
                pump.coin_creator_vault_authority,
                pump.fee_config,
                pump.fee_program,
                &ctx.accounts.token_program,
                pump.token_program_2022,
                &ctx.accounts.system_program,
                &ctx.accounts.associated_token_program,
                pump.event_authority,
                pump.pumpswap_program,
                vault_bump,
                position.token_amount,
                slippage_limit,
            )?;

            remaining = sol_received;

            let market = &mut ctx.accounts.market;
            market.total_long_collateral = market.total_long_collateral
                .saturating_sub(position.collateral);

        } else {
            let tokens_to_buy = position.borrowed_tokens;

            let sol_spent = execute_buy_for_close(
                &ctx.accounts.protocol_vault,
                &mut ctx.accounts.token_vault,
                &mut ctx.accounts.wsol_vault,
                pump.pumpswap_pool,
                pump.pool_base_vault,
                pump.pool_quote_vault,
                pump.pumpswap_global,
                &ctx.accounts.token_mint,
                &ctx.accounts.wsol_mint,
                pump.protocol_fee_recipient,
                pump.protocol_fee_recipient_ata,
                pump.coin_creator_vault_ata,
                pump.coin_creator_vault_authority,
                pump.global_volume_accumulator,
                pump.user_volume_accumulator,
                pump.fee_config,
                pump.fee_program,
                &ctx.accounts.token_program,
                pump.token_program_2022,
                &ctx.accounts.system_program,
                &ctx.accounts.associated_token_program,
                pump.event_authority,
                pump.pumpswap_program,
                vault_bump,
                tokens_to_buy,
                slippage_limit,
            )?;

            let lending = &mut ctx.accounts.lending_pool;
            lending.total_borrowed = lending.total_borrowed.saturating_sub(position.borrowed_tokens);

            remaining = position.position_size_sol.saturating_sub(sol_spent);

            let market = &mut ctx.accounts.market;
            market.total_short_collateral = market.total_short_collateral
                .saturating_sub(position.collateral);
        }

        let market = &mut ctx.accounts.market;
        market.total_positions = market.total_positions.saturating_sub(1);

        let reward = remaining * LIQUIDATOR_REWARD_BPS / BPS_DENOMINATOR;
        let to_owner = remaining.saturating_sub(reward);

        if reward > 0 {
            let protocol_vault_info = ctx.accounts.protocol_vault.to_account_info();
            let liquidator_info = ctx.accounts.liquidator.to_account_info();
            **protocol_vault_info.try_borrow_mut_lamports()? -= reward;
            **liquidator_info.try_borrow_mut_lamports()? += reward;
        }

        if to_owner > 0 {
            let owner_account = &mut ctx.accounts.owner_account;
            owner_account.balance = owner_account.balance.checked_add(to_owner).ok_or(ErrorCode::Overflow)?;
        }

        emit!(PositionLiquidated {
            owner: position.owner,
            market: position.market,
            is_long: position.is_long,
            liquidator: ctx.accounts.liquidator.key(),
            reward,
            exit_price: current_price,
        });

        Ok(())
    }
}

// ========== Helper Functions ==========

/// Pumpswap accounts extracted from remaining_accounts
struct PumpswapAccounts<'a, 'info> {
    pumpswap_pool: &'a AccountInfo<'info>,
    pool_base_vault: &'a AccountInfo<'info>,
    pool_quote_vault: &'a AccountInfo<'info>,
    pumpswap_global: &'a AccountInfo<'info>,
    protocol_fee_recipient: &'a AccountInfo<'info>,
    protocol_fee_recipient_ata: &'a AccountInfo<'info>,
    coin_creator_vault_ata: &'a AccountInfo<'info>,
    coin_creator_vault_authority: &'a AccountInfo<'info>,
    global_volume_accumulator: &'a AccountInfo<'info>,
    user_volume_accumulator: &'a AccountInfo<'info>,
    fee_config: &'a AccountInfo<'info>,
    fee_program: &'a AccountInfo<'info>,
    event_authority: &'a AccountInfo<'info>,
    pumpswap_program: &'a AccountInfo<'info>,
    token_program_2022: &'a AccountInfo<'info>,
}

fn parse_pumpswap_accounts<'a, 'info>(
    remaining: &'a [AccountInfo<'info>],
) -> Result<PumpswapAccounts<'a, 'info>> {
    require!(remaining.len() >= 15, ErrorCode::InvalidPumpswapAccounts);
    Ok(PumpswapAccounts {
        pumpswap_pool: &remaining[0],
        pool_base_vault: &remaining[1],
        pool_quote_vault: &remaining[2],
        pumpswap_global: &remaining[3],
        protocol_fee_recipient: &remaining[4],
        protocol_fee_recipient_ata: &remaining[5],
        coin_creator_vault_ata: &remaining[6],
        coin_creator_vault_authority: &remaining[7],
        global_volume_accumulator: &remaining[8],
        user_volume_accumulator: &remaining[9],
        fee_config: &remaining[10],
        fee_program: &remaining[11],
        event_authority: &remaining[12],
        pumpswap_program: &remaining[13],
        token_program_2022: &remaining[14],
    })
}

fn get_pool_price(base_vault: &AccountInfo, quote_vault: &AccountInfo) -> Result<u64> {
    let base_data = base_vault.try_borrow_data()?;
    let quote_data = quote_vault.try_borrow_data()?;

    let base_amount = u64::from_le_bytes(
        base_data[TOKEN_AMOUNT_OFFSET..TOKEN_AMOUNT_OFFSET + 8].try_into().unwrap()
    );
    let quote_amount = u64::from_le_bytes(
        quote_data[TOKEN_AMOUNT_OFFSET..TOKEN_AMOUNT_OFFSET + 8].try_into().unwrap()
    );

    require!(base_amount > 0, ErrorCode::EmptyPool);

    let price = (quote_amount as u128)
        .checked_mul(PRECISION)
        .ok_or(ErrorCode::Overflow)?
        .checked_div(base_amount as u128)
        .ok_or(ErrorCode::Overflow)? as u64;

    Ok(price)
}

fn calc_liq_price_long(entry_price: u64, leverage: u64) -> Result<u64> {
    let drop_bps = LIQUIDATION_THRESHOLD_BPS / leverage;
    let liq = (entry_price as u128)
        .checked_mul((BPS_DENOMINATOR - drop_bps) as u128)
        .ok_or(ErrorCode::Overflow)?
        .checked_div(BPS_DENOMINATOR as u128)
        .ok_or(ErrorCode::Overflow)? as u64;
    Ok(liq)
}

fn calc_liq_price_short(entry_price: u64, leverage: u64) -> Result<u64> {
    let rise_bps = LIQUIDATION_THRESHOLD_BPS / leverage;
    let liq = (entry_price as u128)
        .checked_mul((BPS_DENOMINATOR + rise_bps) as u128)
        .ok_or(ErrorCode::Overflow)?
        .checked_div(BPS_DENOMINATOR as u128)
        .ok_or(ErrorCode::Overflow)? as u64;
    Ok(liq)
}
#[allow(clippy::too_many_arguments)]
fn execute_buy<'info>(
    protocol_vault: &AccountInfo<'info>,
    token_vault: &mut Account<'info, TokenAccount>,
    wsol_vault: &mut Account<'info, TokenAccount>,
    pumpswap_pool: &AccountInfo<'info>,
    pool_base_vault: &AccountInfo<'info>,
    pool_quote_vault: &AccountInfo<'info>,
    pumpswap_global: &AccountInfo<'info>,
    token_mint: &Account<'info, Mint>,
    wsol_mint: &AccountInfo<'info>,
    protocol_fee_recipient: &AccountInfo<'info>,
    protocol_fee_recipient_ata: &AccountInfo<'info>,
    coin_creator_vault_ata: &AccountInfo<'info>,
    coin_creator_vault_authority: &AccountInfo<'info>,
    global_volume_accumulator: &AccountInfo<'info>,
    user_volume_accumulator: &AccountInfo<'info>,
    fee_config: &AccountInfo<'info>,
    fee_program: &AccountInfo<'info>,
    token_program: &Program<'info, Token>,
    token_program_2022: &AccountInfo<'info>,
    system_program: &Program<'info, System>,
    associated_token_program: &Program<'info, AssociatedToken>,
    event_authority: &AccountInfo<'info>,
    pumpswap_program: &AccountInfo<'info>,
    vault_bump: u8,
    sol_amount: u64,
    min_tokens: u64,
) -> Result<u64> {
    let vault_bump_slice = &[vault_bump];
    let vault_seeds: &[&[u8]] = &[b"protocol_vault", vault_bump_slice];
    let vault_signer_seeds = &[vault_seeds];

    // Transfer SOL from protocol_vault to wsol_vault (wrap SOL)
    anchor_lang::system_program::transfer(
        CpiContext::new_with_signer(
            system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: protocol_vault.to_account_info(),
                to: wsol_vault.to_account_info(),
            },
            vault_signer_seeds,
        ),
        sol_amount,
    )?;

    token::sync_native(
        CpiContext::new(
            token_program.to_account_info(),
            SyncNative {
                account: wsol_vault.to_account_info(),
            },
        ),
    )?;

    let tokens_before = token_vault.amount;

    let mut ix_data = Vec::with_capacity(25);
    ix_data.extend_from_slice(&BUY_DISCRIMINATOR);
    ix_data.extend_from_slice(&min_tokens.to_le_bytes());  // base_amount_out
    ix_data.extend_from_slice(&sol_amount.to_le_bytes());  // max_quote_amount_in
    ix_data.push(0); // track_volume = false

    // Account order per pumpswap IDL buy:
    let accounts = vec![
        AccountMeta::new(pumpswap_pool.key(), false),           // pool
        AccountMeta::new(protocol_vault.key(), true),            // user (signer)
        AccountMeta::new_readonly(pumpswap_global.key(), false), // global_config
        AccountMeta::new_readonly(token_mint.key(), false),      // base_mint
        AccountMeta::new_readonly(wsol_mint.key(), false),       // quote_mint
        AccountMeta::new(token_vault.key(), false),              // user_base_token_account
        AccountMeta::new(wsol_vault.key(), false),               // user_quote_token_account
        AccountMeta::new(pool_base_vault.key(), false),          // pool_base_token_account
        AccountMeta::new(pool_quote_vault.key(), false),         // pool_quote_token_account
        AccountMeta::new_readonly(protocol_fee_recipient.key(), false),
        AccountMeta::new(protocol_fee_recipient_ata.key(), false),
        AccountMeta::new_readonly(token_program_2022.key(), false),  // base_token_program
        AccountMeta::new_readonly(token_program.key(), false),       // quote_token_program
        AccountMeta::new_readonly(system_program.key(), false),
        AccountMeta::new_readonly(associated_token_program.key(), false),
        AccountMeta::new_readonly(event_authority.key(), false),
        AccountMeta::new_readonly(pumpswap_program.key(), false),
        AccountMeta::new(coin_creator_vault_ata.key(), false),
        AccountMeta::new_readonly(coin_creator_vault_authority.key(), false),
        AccountMeta::new_readonly(global_volume_accumulator.key(), false),
        AccountMeta::new(user_volume_accumulator.key(), false),
        AccountMeta::new_readonly(fee_config.key(), false),
        AccountMeta::new_readonly(fee_program.key(), false),
    ];

    invoke_signed(
        &Instruction { program_id: PUMPSWAP_PROGRAM_ID, accounts, data: ix_data },
        &[
            pumpswap_pool.to_account_info(),
            protocol_vault.to_account_info(),
            pumpswap_global.to_account_info(),
            token_mint.to_account_info(),
            wsol_mint.to_account_info(),
            token_vault.to_account_info(),
            wsol_vault.to_account_info(),
            pool_base_vault.to_account_info(),
            pool_quote_vault.to_account_info(),
            protocol_fee_recipient.to_account_info(),
            protocol_fee_recipient_ata.to_account_info(),
            token_program_2022.to_account_info(),
            token_program.to_account_info(),
            system_program.to_account_info(),
            associated_token_program.to_account_info(),
            event_authority.to_account_info(),
            pumpswap_program.to_account_info(),
            coin_creator_vault_ata.to_account_info(),
            coin_creator_vault_authority.to_account_info(),
            global_volume_accumulator.to_account_info(),
            user_volume_accumulator.to_account_info(),
            fee_config.to_account_info(),
            fee_program.to_account_info(),
        ],
        vault_signer_seeds,
    )?;

    token_vault.reload()?;
    let tokens_after = token_vault.amount;
    let received = tokens_after.checked_sub(tokens_before).ok_or(ErrorCode::SwapFailed)?;
    require!(received >= min_tokens, ErrorCode::SlippageExceeded);

    Ok(received)
}

#[allow(clippy::too_many_arguments)]
fn execute_sell<'info>(
    protocol_vault: &AccountInfo<'info>,
    token_vault: &mut Account<'info, TokenAccount>,
    wsol_vault: &mut Account<'info, TokenAccount>,
    pumpswap_pool: &AccountInfo<'info>,
    pool_base_vault: &AccountInfo<'info>,
    pool_quote_vault: &AccountInfo<'info>,
    pumpswap_global: &AccountInfo<'info>,
    token_mint: &Account<'info, Mint>,
    wsol_mint: &AccountInfo<'info>,
    protocol_fee_recipient: &AccountInfo<'info>,
    protocol_fee_recipient_ata: &AccountInfo<'info>,
    coin_creator_vault_ata: &AccountInfo<'info>,
    coin_creator_vault_authority: &AccountInfo<'info>,
    fee_config: &AccountInfo<'info>,
    fee_program: &AccountInfo<'info>,
    token_program: &Program<'info, Token>,
    token_program_2022: &AccountInfo<'info>,
    system_program: &Program<'info, System>,
    associated_token_program: &Program<'info, AssociatedToken>,
    event_authority: &AccountInfo<'info>,
    pumpswap_program: &AccountInfo<'info>,
    vault_bump: u8,
    token_amount: u64,
    min_sol: u64,
) -> Result<u64> {
    let bump_slice = &[vault_bump];
    let seeds: &[&[u8]] = &[b"protocol_vault", bump_slice];
    let signer_seeds = &[seeds];

    let wsol_before = wsol_vault.amount;

    let mut ix_data = Vec::with_capacity(24);
    ix_data.extend_from_slice(&SELL_DISCRIMINATOR);
    ix_data.extend_from_slice(&token_amount.to_le_bytes());
    ix_data.extend_from_slice(&min_sol.to_le_bytes());

    let accounts = vec![
        AccountMeta::new(pumpswap_pool.key(), false),
        AccountMeta::new(protocol_vault.key(), true),
        AccountMeta::new_readonly(pumpswap_global.key(), false),
        AccountMeta::new_readonly(token_mint.key(), false),
        AccountMeta::new_readonly(wsol_mint.key(), false),
        AccountMeta::new(token_vault.key(), false),
        AccountMeta::new(wsol_vault.key(), false),
        AccountMeta::new(pool_base_vault.key(), false),
        AccountMeta::new(pool_quote_vault.key(), false),
        AccountMeta::new_readonly(protocol_fee_recipient.key(), false),
        AccountMeta::new(protocol_fee_recipient_ata.key(), false),
        AccountMeta::new_readonly(token_program_2022.key(), false),
        AccountMeta::new_readonly(token_program.key(), false),
        AccountMeta::new_readonly(system_program.key(), false),
        AccountMeta::new_readonly(associated_token_program.key(), false),
        AccountMeta::new_readonly(event_authority.key(), false),
        AccountMeta::new_readonly(pumpswap_program.key(), false),
        AccountMeta::new(coin_creator_vault_ata.key(), false),
        AccountMeta::new_readonly(coin_creator_vault_authority.key(), false),
        AccountMeta::new_readonly(fee_config.key(), false),
        AccountMeta::new_readonly(fee_program.key(), false),
    ];

    invoke_signed(
        &Instruction { program_id: PUMPSWAP_PROGRAM_ID, accounts, data: ix_data },
        &[
            pumpswap_pool.to_account_info(),
            protocol_vault.to_account_info(),
            pumpswap_global.to_account_info(),
            token_mint.to_account_info(),
            wsol_mint.to_account_info(),
            token_vault.to_account_info(),
            wsol_vault.to_account_info(),
            pool_base_vault.to_account_info(),
            pool_quote_vault.to_account_info(),
            protocol_fee_recipient.to_account_info(),
            protocol_fee_recipient_ata.to_account_info(),
            token_program_2022.to_account_info(),
            token_program.to_account_info(),
            system_program.to_account_info(),
            associated_token_program.to_account_info(),
            event_authority.to_account_info(),
            pumpswap_program.to_account_info(),
            coin_creator_vault_ata.to_account_info(),
            coin_creator_vault_authority.to_account_info(),
            fee_config.to_account_info(),
            fee_program.to_account_info(),
        ],
        signer_seeds,
    )?;

    wsol_vault.reload()?;
    let wsol_after = wsol_vault.amount;
    let received = wsol_after.checked_sub(wsol_before).ok_or(ErrorCode::SwapFailed)?;
    require!(received >= min_sol, ErrorCode::SlippageExceeded);

    Ok(received)
}

#[allow(clippy::too_many_arguments)]
fn execute_buy_for_close<'info>(
    protocol_vault: &AccountInfo<'info>,
    token_vault: &mut Account<'info, TokenAccount>,
    wsol_vault: &mut Account<'info, TokenAccount>,
    pumpswap_pool: &AccountInfo<'info>,
    pool_base_vault: &AccountInfo<'info>,
    pool_quote_vault: &AccountInfo<'info>,
    pumpswap_global: &AccountInfo<'info>,
    token_mint: &Account<'info, Mint>,
    wsol_mint: &AccountInfo<'info>,
    protocol_fee_recipient: &AccountInfo<'info>,
    protocol_fee_recipient_ata: &AccountInfo<'info>,
    coin_creator_vault_ata: &AccountInfo<'info>,
    coin_creator_vault_authority: &AccountInfo<'info>,
    global_volume_accumulator: &AccountInfo<'info>,
    user_volume_accumulator: &AccountInfo<'info>,
    fee_config: &AccountInfo<'info>,
    fee_program: &AccountInfo<'info>,
    token_program: &Program<'info, Token>,
    token_program_2022: &AccountInfo<'info>,
    system_program: &Program<'info, System>,
    associated_token_program: &Program<'info, AssociatedToken>,
    event_authority: &AccountInfo<'info>,
    pumpswap_program: &AccountInfo<'info>,
    vault_bump: u8,
    tokens_to_buy: u64,
    max_sol: u64,
) -> Result<u64> {
    let bump_slice = &[vault_bump];
    let seeds: &[&[u8]] = &[b"protocol_vault", bump_slice];
    let signer_seeds = &[seeds];

    let wsol_before = wsol_vault.amount;

    let mut ix_data = Vec::with_capacity(25);
    ix_data.extend_from_slice(&BUY_DISCRIMINATOR);
    ix_data.extend_from_slice(&tokens_to_buy.to_le_bytes());
    ix_data.extend_from_slice(&max_sol.to_le_bytes());
    ix_data.push(0);

    let accounts = vec![
        AccountMeta::new(pumpswap_pool.key(), false),
        AccountMeta::new(protocol_vault.key(), true),
        AccountMeta::new_readonly(pumpswap_global.key(), false),
        AccountMeta::new_readonly(token_mint.key(), false),
        AccountMeta::new_readonly(wsol_mint.key(), false),
        AccountMeta::new(token_vault.key(), false),
        AccountMeta::new(wsol_vault.key(), false),
        AccountMeta::new(pool_base_vault.key(), false),
        AccountMeta::new(pool_quote_vault.key(), false),
        AccountMeta::new_readonly(protocol_fee_recipient.key(), false),
        AccountMeta::new(protocol_fee_recipient_ata.key(), false),
        AccountMeta::new_readonly(token_program_2022.key(), false),
        AccountMeta::new_readonly(token_program.key(), false),
        AccountMeta::new_readonly(system_program.key(), false),
        AccountMeta::new_readonly(associated_token_program.key(), false),
        AccountMeta::new_readonly(event_authority.key(), false),
        AccountMeta::new_readonly(pumpswap_program.key(), false),
        AccountMeta::new(coin_creator_vault_ata.key(), false),
        AccountMeta::new_readonly(coin_creator_vault_authority.key(), false),
        AccountMeta::new_readonly(global_volume_accumulator.key(), false),
        AccountMeta::new(user_volume_accumulator.key(), false),
        AccountMeta::new_readonly(fee_config.key(), false),
        AccountMeta::new_readonly(fee_program.key(), false),
    ];

    invoke_signed(
        &Instruction { program_id: PUMPSWAP_PROGRAM_ID, accounts, data: ix_data },
        &[
            pumpswap_pool.to_account_info(),
            protocol_vault.to_account_info(),
            pumpswap_global.to_account_info(),
            token_mint.to_account_info(),
            wsol_mint.to_account_info(),
            token_vault.to_account_info(),
            wsol_vault.to_account_info(),
            pool_base_vault.to_account_info(),
            pool_quote_vault.to_account_info(),
            protocol_fee_recipient.to_account_info(),
            protocol_fee_recipient_ata.to_account_info(),
            token_program_2022.to_account_info(),
            token_program.to_account_info(),
            system_program.to_account_info(),
            associated_token_program.to_account_info(),
            event_authority.to_account_info(),
            pumpswap_program.to_account_info(),
            coin_creator_vault_ata.to_account_info(),
            coin_creator_vault_authority.to_account_info(),
            global_volume_accumulator.to_account_info(),
            user_volume_accumulator.to_account_info(),
            fee_config.to_account_info(),
            fee_program.to_account_info(),
        ],
        signer_seeds,
    )?;

    wsol_vault.reload()?;
    let wsol_after = wsol_vault.amount;
    let spent = wsol_before.checked_sub(wsol_after).ok_or(ErrorCode::SwapFailed)?;
    require!(spent <= max_sol, ErrorCode::SlippageExceeded);

    Ok(spent)
}

// ========== Account Contexts ==========

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = 8 + Protocol::INIT_SPACE,
        seeds = [b"protocol"],
        bump,
    )]
    pub protocol: Box<Account<'info, Protocol>>,

    /// CHECK: Global vault PDA
    #[account(
        mut,
        seeds = [b"protocol_vault"],
        bump,
    )]
    pub protocol_vault: AccountInfo<'info>,

    #[account(
        init,
        payer = admin,
        associated_token::mint = wsol_mint,
        associated_token::authority = protocol_vault,
    )]
    pub wsol_vault: Box<Account<'info, TokenAccount>>,

    /// CHECK: WSOL mint
    #[account(address = WSOL_MINT)]
    pub wsol_mint: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UnwrapWsol<'info> {
    pub admin: Signer<'info>,

    #[account(seeds = [b"protocol"], bump = protocol.bump, has_one = admin)]
    pub protocol: Account<'info, Protocol>,

    /// CHECK: Protocol vault
    #[account(mut, seeds = [b"protocol_vault"], bump = protocol.vault_bump)]
    pub protocol_vault: AccountInfo<'info>,

    #[account(mut, associated_token::mint = wsol_mint, associated_token::authority = protocol_vault)]
    pub wsol_vault: Account<'info, TokenAccount>,

    /// CHECK: WSOL mint
    #[account(address = WSOL_MINT)]
    pub wsol_mint: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CreateWsolVault<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(seeds = [b"protocol"], bump = protocol.bump)]
    pub protocol: Account<'info, Protocol>,

    /// CHECK: Protocol vault
    #[account(seeds = [b"protocol_vault"], bump = protocol.vault_bump)]
    pub protocol_vault: AccountInfo<'info>,

    #[account(
        init,
        payer = payer,
        associated_token::mint = wsol_mint,
        associated_token::authority = protocol_vault,
    )]
    pub wsol_vault: Account<'info, TokenAccount>,

    /// CHECK: WSOL mint
    #[account(address = WSOL_MINT)]
    pub wsol_mint: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreateMarket<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(seeds = [b"protocol"], bump = protocol.bump)]
    pub protocol: Box<Account<'info, Protocol>>,

    /// CHECK: Protocol vault
    #[account(seeds = [b"protocol_vault"], bump = protocol.vault_bump)]
    pub protocol_vault: AccountInfo<'info>,

    pub token_mint: Box<Account<'info, Mint>>,

    #[account(
        init, payer = admin, space = 8 + Market::INIT_SPACE,
        seeds = [b"market", token_mint.key().as_ref()], bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        init, payer = admin, space = 8 + LendingPool::INIT_SPACE,
        seeds = [b"lending_pool", market.key().as_ref()], bump,
    )]
    pub lending_pool: Box<Account<'info, LendingPool>>,

    #[account(
        init, payer = admin,
        associated_token::mint = token_mint,
        associated_token::authority = protocol_vault,
    )]
    pub token_vault: Box<Account<'info, TokenAccount>>,

    /// CHECK: Pumpswap pool
    pub pumpswap_pool: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(seeds = [b"protocol"], bump = protocol.bump)]
    pub protocol: Account<'info, Protocol>,

    /// CHECK: Protocol vault
    #[account(mut, seeds = [b"protocol_vault"], bump = protocol.vault_bump)]
    pub protocol_vault: AccountInfo<'info>,

    #[account(
        init_if_needed, payer = user, space = 8 + UserAccount::INIT_SPACE,
        seeds = [b"user_account", user.key().as_ref()], bump,
    )]
    pub user_account: Account<'info, UserAccount>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(seeds = [b"protocol"], bump = protocol.bump)]
    pub protocol: Account<'info, Protocol>,

    /// CHECK: Protocol vault
    #[account(mut, seeds = [b"protocol_vault"], bump = protocol.vault_bump)]
    pub protocol_vault: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [b"user_account", user.key().as_ref()],
        bump = user_account.bump,
        constraint = user_account.owner == user.key() @ ErrorCode::Unauthorized,
    )]
    pub user_account: Account<'info, UserAccount>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositToLending<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(seeds = [b"protocol"], bump = protocol.bump)]
    pub protocol: Box<Account<'info, Protocol>>,

    /// CHECK: Protocol vault
    #[account(seeds = [b"protocol_vault"], bump = protocol.vault_bump)]
    pub protocol_vault: AccountInfo<'info>,

    #[account(mut, seeds = [b"market", market.token_mint.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,

    #[account(mut, seeds = [b"lending_pool", market.key().as_ref()], bump = lending_pool.bump)]
    pub lending_pool: Box<Account<'info, LendingPool>>,

    #[account(
        init_if_needed, payer = user, space = 8 + LenderPosition::INIT_SPACE,
        seeds = [b"lender", user.key().as_ref(), lending_pool.key().as_ref()], bump,
    )]
    pub lender_position: Box<Account<'info, LenderPosition>>,

    #[account(mut, associated_token::mint = token_mint, associated_token::authority = protocol_vault)]
    pub token_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub user_token_account: Box<Account<'info, TokenAccount>>,

    pub token_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawFromLending<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(seeds = [b"protocol"], bump = protocol.bump)]
    pub protocol: Box<Account<'info, Protocol>>,

    /// CHECK: Protocol vault
    #[account(seeds = [b"protocol_vault"], bump = protocol.vault_bump)]
    pub protocol_vault: AccountInfo<'info>,

    #[account(seeds = [b"market", market.token_mint.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,

    #[account(mut, seeds = [b"lending_pool", market.key().as_ref()], bump = lending_pool.bump)]
    pub lending_pool: Box<Account<'info, LendingPool>>,

    #[account(
        mut, seeds = [b"lender", user.key().as_ref(), lending_pool.key().as_ref()],
        bump = lender_position.bump,
        constraint = lender_position.owner == user.key() @ ErrorCode::Unauthorized,
    )]
    pub lender_position: Box<Account<'info, LenderPosition>>,

    #[account(mut, associated_token::mint = token_mint, associated_token::authority = protocol_vault)]
    pub token_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub user_token_account: Box<Account<'info, TokenAccount>>,

    pub token_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct OpenPosition<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(seeds = [b"protocol"], bump = protocol.bump)]
    pub protocol: Box<Account<'info, Protocol>>,

    /// CHECK: Protocol vault
    #[account(mut, seeds = [b"protocol_vault"], bump = protocol.vault_bump)]
    pub protocol_vault: AccountInfo<'info>,

    #[account(mut, seeds = [b"user_account", user.key().as_ref()], bump = user_account.bump)]
    pub user_account: Box<Account<'info, UserAccount>>,

    #[account(mut, seeds = [b"market", market.token_mint.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,

    #[account(mut, seeds = [b"lending_pool", market.key().as_ref()], bump = lending_pool.bump)]
    pub lending_pool: Box<Account<'info, LendingPool>>,

    #[account(mut, associated_token::mint = token_mint, associated_token::authority = protocol_vault)]
    pub token_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, associated_token::mint = wsol_mint, associated_token::authority = protocol_vault)]
    pub wsol_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        init, payer = user, space = 8 + Position::INIT_SPACE,
        seeds = [b"position", user.key().as_ref(), market.key().as_ref()], bump,
    )]
    pub position: Box<Account<'info, Position>>,

    pub token_mint: Box<Account<'info, Mint>>,

    /// CHECK: WSOL mint
    #[account(address = WSOL_MINT)]
    pub wsol_mint: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    // Pumpswap accounts passed via remaining_accounts:
    // [0] pumpswap_pool (mut)
    // [1] pool_base_vault (mut)
    // [2] pool_quote_vault (mut)
    // [3] pumpswap_global
    // [4] protocol_fee_recipient
    // [5] protocol_fee_recipient_ata (mut)
    // [6] coin_creator_vault_ata (mut)
    // [7] coin_creator_vault_authority
    // [8] global_volume_accumulator
    // [9] user_volume_accumulator (mut)
    // [10] fee_config
    // [11] fee_program
    // [12] event_authority
    // [13] pumpswap_program
    // [14] token_program_2022
}

#[derive(Accounts)]
pub struct ClosePosition<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    /// CHECK: Position owner
    #[account(mut)]
    pub position_owner: AccountInfo<'info>,

    #[account(mut, seeds = [b"user_account", user.key().as_ref()], bump = user_account.bump)]
    pub user_account: Box<Account<'info, UserAccount>>,

    #[account(seeds = [b"protocol"], bump = protocol.bump)]
    pub protocol: Box<Account<'info, Protocol>>,

    /// CHECK: Protocol vault
    #[account(mut, seeds = [b"protocol_vault"], bump = protocol.vault_bump)]
    pub protocol_vault: AccountInfo<'info>,

    #[account(mut, seeds = [b"market", market.token_mint.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,

    #[account(mut, seeds = [b"lending_pool", market.key().as_ref()], bump = lending_pool.bump)]
    pub lending_pool: Box<Account<'info, LendingPool>>,

    #[account(mut, associated_token::mint = token_mint, associated_token::authority = protocol_vault)]
    pub token_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, associated_token::mint = wsol_mint, associated_token::authority = protocol_vault)]
    pub wsol_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut, close = position_owner,
        seeds = [b"position", position_owner.key().as_ref(), market.key().as_ref()],
        bump = position.bump,
        constraint = position.owner == user.key() @ ErrorCode::Unauthorized,
    )]
    pub position: Box<Account<'info, Position>>,

    pub token_mint: Box<Account<'info, Mint>>,

    /// CHECK: WSOL mint
    #[account(address = WSOL_MINT)]
    pub wsol_mint: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    // Pumpswap accounts passed via remaining_accounts (same as OpenPosition)
}

#[derive(Accounts)]
pub struct Liquidate<'info> {
    #[account(mut)]
    pub liquidator: Signer<'info>,

    /// CHECK: Position owner
    #[account(mut)]
    pub position_owner: AccountInfo<'info>,

    #[account(mut, seeds = [b"user_account", position_owner.key().as_ref()], bump = owner_account.bump)]
    pub owner_account: Box<Account<'info, UserAccount>>,

    #[account(seeds = [b"protocol"], bump = protocol.bump)]
    pub protocol: Box<Account<'info, Protocol>>,

    /// CHECK: Protocol vault
    #[account(mut, seeds = [b"protocol_vault"], bump = protocol.vault_bump)]
    pub protocol_vault: AccountInfo<'info>,

    #[account(mut, seeds = [b"market", market.token_mint.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,

    #[account(mut, seeds = [b"lending_pool", market.key().as_ref()], bump = lending_pool.bump)]
    pub lending_pool: Box<Account<'info, LendingPool>>,

    #[account(mut, associated_token::mint = token_mint, associated_token::authority = protocol_vault)]
    pub token_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, associated_token::mint = wsol_mint, associated_token::authority = protocol_vault)]
    pub wsol_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut, close = position_owner,
        seeds = [b"position", position_owner.key().as_ref(), market.key().as_ref()],
        bump = position.bump,
    )]
    pub position: Box<Account<'info, Position>>,

    pub token_mint: Box<Account<'info, Mint>>,

    /// CHECK: WSOL mint
    #[account(address = WSOL_MINT)]
    pub wsol_mint: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    // Pumpswap accounts passed via remaining_accounts (same as OpenPosition)
}

// ========== State ==========

#[account]
#[derive(InitSpace)]
pub struct Protocol {
    pub admin: Pubkey,
    pub bump: u8,
    pub vault_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Market {
    pub token_mint: Pubkey,
    pub pumpswap_pool: Pubkey,
    pub total_long_collateral: u64,
    pub total_short_collateral: u64,
    pub total_positions: u64,
    pub max_position_size: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct LendingPool {
    pub market: Pubkey,
    pub token_mint: Pubkey,
    pub total_deposits: u64,
    pub total_borrowed: u64,
    pub total_shares: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct LenderPosition {
    pub owner: Pubkey,
    pub lending_pool: Pubkey,
    pub shares: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct UserAccount {
    pub owner: Pubkey,
    pub balance: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Position {
    pub owner: Pubkey,
    pub market: Pubkey,
    pub is_long: bool,
    pub collateral: u64,
    pub leverage: u64,
    pub entry_price: u64,
    pub liquidation_price: u64,
    pub token_amount: u64,
    pub position_size_sol: u64,
    pub borrowed_tokens: u64,
    pub opened_at: i64,
    pub bump: u8,
}

// ========== Events ==========

#[event]
pub struct ProtocolInitialized { pub admin: Pubkey }

#[event]
pub struct MarketCreated { 
    pub token_mint: Pubkey, 
    pub pumpswap_pool: Pubkey,
    pub max_position_size: u64,
}

#[event]
pub struct Deposited { pub user: Pubkey, pub amount: u64, pub new_balance: u64 }

#[event]
pub struct Withdrawn { pub user: Pubkey, pub amount: u64, pub new_balance: u64 }

#[event]
pub struct LendingDeposited { pub user: Pubkey, pub amount: u64, pub shares: u64 }

#[event]
pub struct LendingWithdrawn { pub user: Pubkey, pub tokens: u64, pub shares: u64 }

#[event]
pub struct PositionOpened {
    pub owner: Pubkey,
    pub market: Pubkey,
    pub is_long: bool,
    pub collateral: u64,
    pub leverage: u64,
    pub entry_price: u64,
    pub liquidation_price: u64,
}

#[event]
pub struct PositionClosed {
    pub owner: Pubkey,
    pub market: Pubkey,
    pub is_long: bool,
    pub entry_price: u64,
    pub exit_price: u64,
    pub pnl: i64,
    pub payout: u64,
}

#[event]
pub struct PositionLiquidated {
    pub owner: Pubkey,
    pub market: Pubkey,
    pub is_long: bool,
    pub liquidator: Pubkey,
    pub reward: u64,
    pub exit_price: u64,
}

// ========== Errors ==========

#[error_code]
pub enum ErrorCode {
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Leverage must be 1-10")]
    InvalidLeverage,
    #[msg("Zero collateral")]
    ZeroCollateral,
    #[msg("Zero amount")]
    ZeroAmount,
    #[msg("Insufficient balance")]
    InsufficientBalance,
    #[msg("Insufficient shares")]
    InsufficientShares,
    #[msg("Insufficient liquidity in lending pool")]
    InsufficientLiquidity,
    #[msg("Invalid pool")]
    InvalidPool,
    #[msg("Pool mint mismatch")]
    PoolMintMismatch,
    #[msg("Empty pool")]
    EmptyPool,
    #[msg("Not liquidatable")]
    NotLiquidatable,
    #[msg("Swap failed")]
    SwapFailed,
    #[msg("Slippage exceeded")]
    SlippageExceeded,
    #[msg("Math overflow")]
    Overflow,
    #[msg("Position size exceeds market limit")]
    PositionTooLarge,
    #[msg("Invalid pumpswap accounts in remaining_accounts")]
    InvalidPumpswapAccounts,
}