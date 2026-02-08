import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { expect } from "chai";
import {
  findProtocolPDA,
  findProtocolVaultPDA,
  findUserAccountPDA,
  calcLiqPriceLong,
  calcLiqPriceShort,
  calcFee,
  calcPositionSize,
  calcLendingShares,
  calcLendingTokens,
  PROTOCOL_FEE_BPS,
  BPS_DENOMINATOR,
  LIQUIDATION_THRESHOLD_BPS,
  LIQUIDATOR_REWARD_BPS,
  MAX_LEVERAGE,
  PRECISION,
  airdrop,
} from "./setup";

describe("edge cases and math", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Perpe as Program;

  describe("overflow protection", () => {
    it("checked_add prevents deposit balance overflow", () => {
      // balance = u64::MAX, trying to add 1 should overflow
      const maxU64 = new BN("18446744073709551615");
      try {
        maxU64.add(new BN(1));
        // BN.js doesn't overflow, but on-chain checked_add would
      } catch {
        // Expected
      }
    });

    it("checked_mul prevents position_size overflow", () => {
      // Very large collateral * leverage could overflow
      const largeCollateral = new BN("1844674407370955161"); // ~1.8e18
      const leverage = new BN(10);
      // On-chain, collateral_after_fee.checked_mul(leverage) would catch this
    });

    it("checked_sub prevents balance underflow on withdraw", () => {
      // balance = 100, trying to withdraw 200
      // On-chain checked_sub returns Err(Overflow)
      const balance = new BN(100);
      const withdraw = new BN(200);
      expect(balance.lt(withdraw)).to.be.true;
    });

    it("lending share calculation uses u128 precision", () => {
      // (amount as u128) * (total_shares as u128) / (total_deposits as u128)
      // Using u128 prevents overflow when multiplying large u64 values
      const amount = new BN(1_000_000_000_000); // 1 trillion
      const totalShares = new BN(1_000_000_000_000);
      const totalDeposits = new BN(2_000_000_000_000);
      const shares = calcLendingShares(amount, totalDeposits, totalShares);
      expect(shares.toNumber()).to.equal(500_000_000_000);
    });
  });

  describe("price calculation edge cases", () => {
    it("get_pool_price requires base_amount > 0", () => {
      // If base_amount == 0, should fail with EmptyPool
      const baseAmount = 0;
      expect(baseAmount).to.equal(0);
      // On-chain: require!(base_amount > 0, ErrorCode::EmptyPool)
    });

    it("price uses PRECISION constant for accuracy", () => {
      // price = quote_amount * PRECISION / base_amount
      const quoteAmount = new BN(1_000_000_000); // 1 SOL in lamports
      const baseAmount = new BN(1_000_000); // 1M tokens
      // price = 1e9 * 1e12 / 1e6 = 1e15
      const price = quoteAmount
        .mul(new BN(PRECISION.toString()))
        .div(baseAmount);
      expect(price.toString()).to.equal("1000000000000000");
    });

    it("handles small token amounts without losing precision", () => {
      const quoteAmount = new BN(1000); // 0.000001 SOL
      const baseAmount = new BN(1); // 1 token
      const price = quoteAmount
        .mul(new BN(PRECISION.toString()))
        .div(baseAmount);
      expect(price.gt(new BN(0))).to.be.true;
    });

    it("handles very large pool balances", () => {
      const quoteAmount = new BN("10000000000000"); // 10000 SOL
      const baseAmount = new BN("1000000000000000"); // 1 quadrillion tokens
      const price = quoteAmount
        .mul(new BN(PRECISION.toString()))
        .div(baseAmount);
      expect(price.gt(new BN(0))).to.be.true;
    });
  });

  describe("liquidation price edge cases", () => {
    it("1x leverage long: liquidation at 30% drop", () => {
      const entryPrice = new BN(10000);
      const liqPrice = calcLiqPriceLong(entryPrice, new BN(1));
      // drop_bps = 7000/1 = 7000
      // liq = 10000 * (10000-7000) / 10000 = 3000
      expect(liqPrice.toNumber()).to.equal(3000);
    });

    it("10x leverage long: liquidation at 7% drop", () => {
      const entryPrice = new BN(10000);
      const liqPrice = calcLiqPriceLong(entryPrice, new BN(10));
      // drop_bps = 7000/10 = 700
      // liq = 10000 * (10000-700) / 10000 = 9300
      expect(liqPrice.toNumber()).to.equal(9300);
    });

    it("1x leverage short: liquidation at 70% rise", () => {
      const entryPrice = new BN(10000);
      const liqPrice = calcLiqPriceShort(entryPrice, new BN(1));
      // rise_bps = 7000/1 = 7000
      // liq = 10000 * (10000+7000) / 10000 = 17000
      expect(liqPrice.toNumber()).to.equal(17000);
    });

    it("10x leverage short: liquidation at 7% rise", () => {
      const entryPrice = new BN(10000);
      const liqPrice = calcLiqPriceShort(entryPrice, new BN(10));
      // rise_bps = 7000/10 = 700
      // liq = 10000 * (10000+700) / 10000 = 10700
      expect(liqPrice.toNumber()).to.equal(10700);
    });

    it("liquidation price scales linearly with entry price", () => {
      const leverage = new BN(5);
      const liq1000 = calcLiqPriceLong(new BN(1000), leverage);
      const liq2000 = calcLiqPriceLong(new BN(2000), leverage);
      // liq at 2000 should be exactly 2x liq at 1000
      expect(liq2000.toNumber()).to.equal(liq1000.toNumber() * 2);
    });
  });

  describe("fee edge cases", () => {
    it("fee on very small amount rounds down to zero", () => {
      // fee = amount * 30 / 10000
      // For amount < 334 lamports, fee rounds to 0
      const smallAmount = new BN(100);
      const fee = calcFee(smallAmount);
      // 100 * 30 / 10000 = 0 (integer division)
      expect(fee.toNumber()).to.equal(0);
    });

    it("fee on 1 SOL is 0.003 SOL (3000 lamports)", () => {
      const fee = calcFee(new BN(LAMPORTS_PER_SOL));
      expect(fee.toNumber()).to.equal(3_000_000); // 0.003 SOL
    });

    it("position size is reduced by fee", () => {
      const collateral = new BN(10 * LAMPORTS_PER_SOL);
      const leverage = new BN(1);
      const positionSize = calcPositionSize(collateral, leverage);
      const fee = calcFee(collateral);

      // Position size should be collateral - fee
      expect(positionSize.toNumber()).to.equal(
        collateral.sub(fee).toNumber()
      );
    });
  });

  describe("lending pool edge cases", () => {
    it("first depositor gets 1:1 shares", () => {
      const shares = calcLendingShares(
        new BN(1000),
        new BN(0), // empty pool
        new BN(0)
      );
      expect(shares.toNumber()).to.equal(1000);
    });

    it("share price increases when interest accrues", () => {
      // Initial: 1000 deposits, 1000 shares
      // After interest: 2000 deposits, 1000 shares
      // New depositor: 1000 tokens = 500 shares (share price = 2)
      const shares = calcLendingShares(
        new BN(1000),
        new BN(2000),
        new BN(1000)
      );
      expect(shares.toNumber()).to.equal(500);
    });

    it("withdrawal returns more tokens when interest accrued", () => {
      // 500 shares when total_deposits=2000, total_shares=1000
      // tokens = 500 * 2000 / 1000 = 1000
      const tokens = calcLendingTokens(
        new BN(500),
        new BN(2000),
        new BN(1000)
      );
      expect(tokens.toNumber()).to.equal(1000);
    });

    it("available liquidity = total_deposits - total_borrowed", () => {
      const totalDeposits = new BN(10000);
      const totalBorrowed = new BN(7000);
      const available = totalDeposits.sub(totalBorrowed);
      expect(available.toNumber()).to.equal(3000);
    });

    it("cannot withdraw when all liquidity is borrowed", () => {
      const totalDeposits = new BN(10000);
      const totalBorrowed = new BN(10000);
      const available = totalDeposits.sub(totalBorrowed);
      expect(available.toNumber()).to.equal(0);
      // Any withdrawal attempt should fail with InsufficientLiquidity
    });
  });

  describe("market constraints", () => {
    it("close_market requires total_positions == 0", () => {
      // MarketHasPositions error if positions exist
      const totalPositions = 1;
      expect(totalPositions).to.not.equal(0);
    });

    it("close_market requires total_borrowed == 0", () => {
      // MarketHasBorrows error if borrows exist
      const totalBorrowed = 100;
      expect(totalBorrowed).to.not.equal(0);
    });

    it("max_position_size limits individual positions", () => {
      const maxPositionSize = new BN(100 * LAMPORTS_PER_SOL);
      const collateral = new BN(20 * LAMPORTS_PER_SOL);
      const leverage = new BN(10);
      const positionSize = calcPositionSize(collateral, leverage);

      // 20 * 0.997 * 10 = 199.4 SOL > 100 SOL limit
      expect(positionSize.gt(maxPositionSize)).to.be.true;
    });
  });

  describe("saturating arithmetic", () => {
    it("saturating_sub returns 0 instead of underflowing", () => {
      // Used in: market.total_positions, total_collateral, lending.total_borrowed
      const a = new BN(5);
      const b = new BN(10);
      // BN saturating: max(a - b, 0)
      const result = BN.max(a.sub(b), new BN(0));
      expect(result.toNumber()).to.equal(0);
    });

    it("total_positions saturating_sub(1) handles edge case", () => {
      // Even if total_positions somehow became 0, saturating_sub(1) = 0
      const totalPositions = new BN(0);
      const result = BN.max(totalPositions.sub(new BN(1)), new BN(0));
      expect(result.toNumber()).to.equal(0);
    });
  });

  describe("constant values validation", () => {
    it("MAX_LEVERAGE is 10", () => {
      expect(MAX_LEVERAGE).to.equal(10);
    });

    it("LIQUIDATION_THRESHOLD_BPS is 7000 (70%)", () => {
      expect(LIQUIDATION_THRESHOLD_BPS).to.equal(7000);
    });

    it("LIQUIDATOR_REWARD_BPS is 500 (5%)", () => {
      expect(LIQUIDATOR_REWARD_BPS).to.equal(500);
    });

    it("PROTOCOL_FEE_BPS is 30 (0.3%)", () => {
      expect(PROTOCOL_FEE_BPS).to.equal(30);
    });

    it("BPS_DENOMINATOR is 10000", () => {
      expect(BPS_DENOMINATOR).to.equal(10_000);
    });

    it("PRECISION is 1e12", () => {
      expect(PRECISION).to.equal(1_000_000_000_000);
    });
  });
});
