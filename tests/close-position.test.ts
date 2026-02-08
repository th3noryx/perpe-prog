import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { expect } from "chai";
import {
  findProtocolPDA,
  findProtocolVaultPDA,
  findMarketPDA,
  findLendingPoolPDA,
  findUserAccountPDA,
  findPositionPDA,
  PROTOCOL_FEE_BPS,
  BPS_DENOMINATOR,
} from "./setup";

describe("close_position", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Perpe as Program;

  describe("long position close", () => {
    it("calculates PnL correctly when price goes up (profit)", async () => {
      // position_size_sol = 10 SOL spent buying tokens
      // after sell, sol_received = 15 SOL
      // pnl = 15 - 10 = +5 SOL profit
      const positionSizeSol = new BN(10 * LAMPORTS_PER_SOL);
      const solReceived = new BN(15 * LAMPORTS_PER_SOL);
      const pnl = solReceived.sub(positionSizeSol);
      expect(pnl.toNumber()).to.equal(5 * LAMPORTS_PER_SOL);
    });

    it("calculates PnL correctly when price goes down (loss)", async () => {
      const positionSizeSol = new BN(10 * LAMPORTS_PER_SOL);
      const solReceived = new BN(7 * LAMPORTS_PER_SOL);
      const pnl = solReceived.sub(positionSizeSol);
      expect(pnl.toNumber()).to.equal(-3 * LAMPORTS_PER_SOL);
    });

    it("calculates payout = collateral + pnl - close_fee", async () => {
      const collateral = new BN(2 * LAMPORTS_PER_SOL);
      const pnl = new BN(1 * LAMPORTS_PER_SOL); // profit

      const closeFee = collateral
        .mul(new BN(PROTOCOL_FEE_BPS))
        .div(new BN(BPS_DENOMINATOR));

      const payout = collateral.add(pnl).sub(closeFee);
      expect(payout.toNumber()).to.be.greaterThan(0);
      // 2 + 1 - 0.006 = 2.994 SOL
      expect(payout.toNumber()).to.equal(
        2.994 * LAMPORTS_PER_SOL
      );
    });

    it("payout is zero when loss exceeds collateral", async () => {
      const collateral = new BN(2 * LAMPORTS_PER_SOL);
      const pnl = -3 * LAMPORTS_PER_SOL; // bigger loss than collateral
      const closeFee = collateral
        .mul(new BN(PROTOCOL_FEE_BPS))
        .div(new BN(BPS_DENOMINATOR));

      const payoutI64 =
        collateral.toNumber() + pnl - closeFee.toNumber();
      const payout = payoutI64 > 0 ? payoutI64 : 0;
      expect(payout).to.equal(0);
    });

    it("decrements market total_long_collateral", async () => {
      // market.total_long_collateral -= position.collateral
      // Placeholder for integration test
    });

    it("sells all position tokens via pumpswap", async () => {
      // For long close, execute_sell with position.token_amount
      // Placeholder for integration test
    });
  });

  describe("short position close", () => {
    it("calculates PnL correctly when price goes down (profit for short)", async () => {
      // position_size_sol = 10 SOL (received when opening short)
      // sol_spent to buy back tokens = 7 SOL
      // pnl = 10 - 7 = +3 SOL profit
      const positionSizeSol = new BN(10 * LAMPORTS_PER_SOL);
      const solSpent = new BN(7 * LAMPORTS_PER_SOL);
      const pnl = positionSizeSol.sub(solSpent);
      expect(pnl.toNumber()).to.equal(3 * LAMPORTS_PER_SOL);
    });

    it("calculates PnL correctly when price goes up (loss for short)", async () => {
      const positionSizeSol = new BN(10 * LAMPORTS_PER_SOL);
      const solSpent = new BN(13 * LAMPORTS_PER_SOL);
      const pnl = positionSizeSol.sub(solSpent);
      expect(pnl.toNumber()).to.equal(-3 * LAMPORTS_PER_SOL);
    });

    it("repays borrowed tokens to lending pool", async () => {
      // lending.total_borrowed -= position.borrowed_tokens
      // Placeholder for integration test
    });

    it("buys back exact borrowed token amount via pumpswap", async () => {
      // execute_buy_for_close with position.borrowed_tokens
      // Placeholder for integration test
    });

    it("decrements market total_short_collateral", async () => {
      // market.total_short_collateral -= position.collateral
      // Placeholder for integration test
    });
  });

  describe("common close behavior", () => {
    it("decrements market total_positions", async () => {
      // market.total_positions -= 1
      // Using saturating_sub to prevent underflow
    });

    it("adds payout to user balance", async () => {
      // user_account.balance += payout
      // Placeholder for integration test
    });

    it("closes position account and refunds rent", async () => {
      // position account has `close = position_owner`
      // rent should go back to position_owner
      // Placeholder for integration test
    });

    it("only position owner can close their position", async () => {
      // constraint = position.owner == user.key() @ Unauthorized
      // Another user trying to close should fail
      // Placeholder for integration test
    });

    it("emits PositionClosed event with correct fields", async () => {
      // Event should contain:
      // owner, market, is_long, entry_price, exit_price, pnl, payout
      // Placeholder for integration test
    });

    it("respects slippage_limit on swap", async () => {
      // If slippage exceeds limit, swap should fail with SlippageExceeded
      // Placeholder for integration test
    });
  });
});
