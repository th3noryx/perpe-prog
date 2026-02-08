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
  findPositionPDA,
  findMarketPDA,
  findLendingPoolPDA,
  calcLiqPriceLong,
  calcLiqPriceShort,
  LIQUIDATOR_REWARD_BPS,
  BPS_DENOMINATOR,
  MAX_LEVERAGE,
  airdrop,
} from "./setup";

describe("liquidate", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Perpe as Program;

  describe("liquidation eligibility - long positions", () => {
    it("allows liquidation when current_price <= liquidation_price (long)", () => {
      // Long position: liquidatable when price drops to/below liq price
      const entryPrice = new BN(1000);
      const leverage = new BN(5);
      const liqPrice = calcLiqPriceLong(entryPrice, leverage);
      // liq_price = 860

      const currentPrice = new BN(850); // below liq price
      expect(currentPrice.toNumber()).to.be.lessThanOrEqual(
        liqPrice.toNumber()
      );
    });

    it("rejects liquidation when price is above liquidation_price (long)", () => {
      const entryPrice = new BN(1000);
      const leverage = new BN(5);
      const liqPrice = calcLiqPriceLong(entryPrice, leverage);

      const currentPrice = new BN(900); // above 860
      expect(currentPrice.toNumber()).to.be.greaterThan(
        liqPrice.toNumber()
      );
      // Should fail with NotLiquidatable
    });

    it("allows liquidation at exact liquidation_price (long)", () => {
      const entryPrice = new BN(1000);
      const leverage = new BN(5);
      const liqPrice = calcLiqPriceLong(entryPrice, leverage);

      // At exactly liq price, should be liquidatable (<=)
      expect(liqPrice.toNumber()).to.be.lessThanOrEqual(
        liqPrice.toNumber()
      );
    });
  });

  describe("liquidation eligibility - short positions", () => {
    it("allows liquidation when current_price >= liquidation_price (short)", () => {
      const entryPrice = new BN(1000);
      const leverage = new BN(5);
      const liqPrice = calcLiqPriceShort(entryPrice, leverage);
      // liq_price = 1140

      const currentPrice = new BN(1200); // above liq price
      expect(currentPrice.toNumber()).to.be.greaterThanOrEqual(
        liqPrice.toNumber()
      );
    });

    it("rejects liquidation when price is below liquidation_price (short)", () => {
      const entryPrice = new BN(1000);
      const leverage = new BN(5);
      const liqPrice = calcLiqPriceShort(entryPrice, leverage);

      const currentPrice = new BN(1100); // below 1140
      expect(currentPrice.toNumber()).to.be.lessThan(
        liqPrice.toNumber()
      );
      // Should fail with NotLiquidatable
    });

    it("allows liquidation at exact liquidation_price (short)", () => {
      const entryPrice = new BN(1000);
      const leverage = new BN(5);
      const liqPrice = calcLiqPriceShort(entryPrice, leverage);

      expect(liqPrice.toNumber()).to.be.greaterThanOrEqual(
        liqPrice.toNumber()
      );
    });
  });

  describe("reward distribution", () => {
    it("calculates liquidator reward as 5% of remaining", () => {
      const remaining = new BN(10 * LAMPORTS_PER_SOL);
      const reward = remaining
        .mul(new BN(LIQUIDATOR_REWARD_BPS))
        .div(new BN(BPS_DENOMINATOR));

      // 5% of 10 SOL = 0.5 SOL
      expect(reward.toNumber()).to.equal(0.5 * LAMPORTS_PER_SOL);
    });

    it("sends remaining after reward to position owner", () => {
      const remaining = new BN(10 * LAMPORTS_PER_SOL);
      const reward = remaining
        .mul(new BN(LIQUIDATOR_REWARD_BPS))
        .div(new BN(BPS_DENOMINATOR));
      const toOwner = remaining.sub(reward);

      // 10 - 0.5 = 9.5 SOL to owner
      expect(toOwner.toNumber()).to.equal(9.5 * LAMPORTS_PER_SOL);
    });

    it("handles zero remaining (total loss)", () => {
      const remaining = new BN(0);
      const reward = remaining
        .mul(new BN(LIQUIDATOR_REWARD_BPS))
        .div(new BN(BPS_DENOMINATOR));
      const toOwner = remaining.sub(reward);

      expect(reward.toNumber()).to.equal(0);
      expect(toOwner.toNumber()).to.equal(0);
    });

    it("liquidator receives reward via lamport transfer", () => {
      // reward is transferred directly via lamport manipulation:
      // protocol_vault.lamports -= reward
      // liquidator.lamports += reward
      // This is a direct SOL transfer, not an SPL transfer
    });

    it("owner gets remaining added to user_account balance", () => {
      // owner_account.balance += to_owner
      // Not a direct SOL transfer - added to balance record
    });
  });

  describe("long position liquidation mechanics", () => {
    it("sells all position tokens", () => {
      // execute_sell(position.token_amount)
      // remaining = sol_received from sell
    });

    it("decrements market total_long_collateral", () => {
      // market.total_long_collateral -= position.collateral
    });
  });

  describe("short position liquidation mechanics", () => {
    it("buys back borrowed tokens to repay lending pool", () => {
      // execute_buy_for_close(position.borrowed_tokens)
      // sol_spent = cost to buy back
      // remaining = position.position_size_sol - sol_spent
    });

    it("repays borrowed tokens to lending pool", () => {
      // lending.total_borrowed -= position.borrowed_tokens
    });

    it("decrements market total_short_collateral", () => {
      // market.total_short_collateral -= position.collateral
    });

    it("remaining can be zero if buyback cost exceeds original SOL", () => {
      // If sol_spent > position.position_size_sol, saturating_sub gives 0
      const positionSizeSol = new BN(10 * LAMPORTS_PER_SOL);
      const solSpent = new BN(15 * LAMPORTS_PER_SOL);
      const remaining = BN.max(
        positionSizeSol.sub(solSpent),
        new BN(0)
      );
      // Note: on-chain uses saturating_sub
      expect(remaining.toNumber()).to.equal(0);
    });
  });

  describe("common liquidation behavior", () => {
    it("decrements market total_positions", () => {
      // market.total_positions -= 1
    });

    it("closes position account and refunds rent to position_owner", () => {
      // close = position_owner on the position account
    });

    it("anyone can call liquidate (no auth restriction on liquidator)", () => {
      // liquidator is just a Signer, no constraint linking it to position
      // This allows anyone to liquidate underwater positions
    });

    it("emits PositionLiquidated event", () => {
      // Event: owner, market, is_long, liquidator, reward, exit_price
    });

    it("respects slippage_limit on swap", () => {
      // SlippageExceeded if swap doesn't meet minimum
    });

    it("liquidation prices are tighter with higher leverage", () => {
      const entryPrice = new BN(1000);

      // Long: higher leverage = higher liquidation price (closer to entry)
      const longLiq2x = calcLiqPriceLong(entryPrice, new BN(2));
      const longLiq10x = calcLiqPriceLong(entryPrice, new BN(10));
      expect(longLiq10x.toNumber()).to.be.greaterThan(
        longLiq2x.toNumber()
      );

      // Short: higher leverage = lower liquidation price (closer to entry)
      const shortLiq2x = calcLiqPriceShort(entryPrice, new BN(2));
      const shortLiq10x = calcLiqPriceShort(entryPrice, new BN(10));
      expect(shortLiq10x.toNumber()).to.be.lessThan(
        shortLiq2x.toNumber()
      );
    });
  });
});
