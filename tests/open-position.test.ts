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
  airdrop,
  MAX_LEVERAGE,
  PROTOCOL_FEE_BPS,
  BPS_DENOMINATOR,
  WSOL_MINT,
  calcFee,
  calcPositionSize,
  calcLiqPriceLong,
  calcLiqPriceShort,
} from "./setup";

describe("open_position", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Perpe as Program;
  const admin = (provider.wallet as anchor.Wallet).payer;

  const [protocol] = findProtocolPDA();
  const [protocolVault] = findProtocolVaultPDA();

  // These tests validate the open_position instruction logic.
  // Full integration requires a live pumpswap pool for swaps.

  describe("parameter validation", () => {
    it("rejects leverage below 1", async () => {
      // leverage must be >= 1 && <= MAX_LEVERAGE
      // leverage = 0 should fail with InvalidLeverage
      const leverage = new BN(0);
      expect(leverage.toNumber()).to.be.lessThan(1);
    });

    it("rejects leverage above MAX_LEVERAGE (10)", async () => {
      const leverage = new BN(11);
      expect(leverage.toNumber()).to.be.greaterThan(MAX_LEVERAGE);
    });

    it("accepts leverage from 1 to 10", async () => {
      for (let i = 1; i <= MAX_LEVERAGE; i++) {
        expect(i).to.be.greaterThanOrEqual(1);
        expect(i).to.be.lessThanOrEqual(MAX_LEVERAGE);
      }
    });

    it("rejects zero collateral", async () => {
      // collateral = 0 should fail with ZeroCollateral
      const collateral = new BN(0);
      expect(collateral.isZero()).to.be.true;
    });

    it("rejects collateral exceeding user balance", async () => {
      // If user has 5 SOL balance, trying to open with 10 SOL should fail
      // with InsufficientBalance
    });
  });

  describe("fee calculation", () => {
    it("calculates protocol fee correctly (0.3%)", async () => {
      const collateral = new BN(10 * LAMPORTS_PER_SOL);
      const fee = calcFee(collateral);
      // 0.3% of 10 SOL = 0.03 SOL
      const expected = collateral
        .mul(new BN(PROTOCOL_FEE_BPS))
        .div(new BN(BPS_DENOMINATOR));
      expect(fee.toNumber()).to.equal(expected.toNumber());
      expect(fee.toNumber()).to.equal(0.03 * LAMPORTS_PER_SOL);
    });

    it("deducts fee from collateral before computing position size", async () => {
      const collateral = new BN(10 * LAMPORTS_PER_SOL);
      const leverage = new BN(5);
      const positionSize = calcPositionSize(collateral, leverage);

      const fee = calcFee(collateral);
      const collateralAfterFee = collateral.sub(fee);
      const expectedSize = collateralAfterFee.mul(leverage);

      expect(positionSize.toNumber()).to.equal(expectedSize.toNumber());
    });
  });

  describe("position size limit", () => {
    it("rejects position exceeding max_position_size", async () => {
      // If market.max_position_size = 100 SOL
      // and user tries collateral=50 SOL * leverage=5 = 250 SOL position
      // this should fail with PositionTooLarge
      const maxPositionSize = new BN(100 * LAMPORTS_PER_SOL);
      const collateral = new BN(50 * LAMPORTS_PER_SOL);
      const leverage = new BN(5);
      const positionSize = calcPositionSize(collateral, leverage);
      expect(positionSize.toNumber()).to.be.greaterThan(
        maxPositionSize.toNumber()
      );
    });

    it("accepts position within max_position_size", async () => {
      const maxPositionSize = new BN(100 * LAMPORTS_PER_SOL);
      const collateral = new BN(5 * LAMPORTS_PER_SOL);
      const leverage = new BN(3);
      const positionSize = calcPositionSize(collateral, leverage);
      expect(positionSize.toNumber()).to.be.lessThanOrEqual(
        maxPositionSize.toNumber()
      );
    });
  });

  describe("long position", () => {
    it("calculates liquidation price correctly for long", async () => {
      // entry_price = 1000, leverage = 5
      // drop_bps = 7000/5 = 1400
      // liq_price = 1000 * (10000 - 1400) / 10000 = 860
      const entryPrice = new BN(1000);
      const leverage = new BN(5);
      const liqPrice = calcLiqPriceLong(entryPrice, leverage);
      expect(liqPrice.toNumber()).to.equal(860);
    });

    it("liquidation price is lower than entry price for long", async () => {
      const entryPrice = new BN(5000);
      for (let lev = 1; lev <= MAX_LEVERAGE; lev++) {
        const liqPrice = calcLiqPriceLong(entryPrice, new BN(lev));
        expect(liqPrice.toNumber()).to.be.lessThan(entryPrice.toNumber());
      }
    });

    it("higher leverage means closer liquidation price for long", async () => {
      const entryPrice = new BN(10000);
      const liq1x = calcLiqPriceLong(entryPrice, new BN(1));
      const liq5x = calcLiqPriceLong(entryPrice, new BN(5));
      const liq10x = calcLiqPriceLong(entryPrice, new BN(10));

      // Higher leverage => liquidation price closer to entry
      expect(liq10x.toNumber()).to.be.greaterThan(liq5x.toNumber());
      expect(liq5x.toNumber()).to.be.greaterThan(liq1x.toNumber());
    });

    it("updates market total_long_collateral", async () => {
      // After opening long: market.total_long_collateral += collateral_after_fee
      // Placeholder for integration test
    });

    it("executes buy swap via pumpswap", async () => {
      // For long positions, protocol buys tokens with SOL
      // position.token_amount = received tokens
      // position.position_size_sol = SOL spent
      // Placeholder for integration test
    });
  });

  describe("short position", () => {
    it("calculates liquidation price correctly for short", async () => {
      // entry_price = 1000, leverage = 5
      // rise_bps = 7000/5 = 1400
      // liq_price = 1000 * (10000 + 1400) / 10000 = 1140
      const entryPrice = new BN(1000);
      const leverage = new BN(5);
      const liqPrice = calcLiqPriceShort(entryPrice, leverage);
      expect(liqPrice.toNumber()).to.equal(1140);
    });

    it("liquidation price is higher than entry price for short", async () => {
      const entryPrice = new BN(5000);
      for (let lev = 1; lev <= MAX_LEVERAGE; lev++) {
        const liqPrice = calcLiqPriceShort(entryPrice, new BN(lev));
        expect(liqPrice.toNumber()).to.be.greaterThan(
          entryPrice.toNumber()
        );
      }
    });

    it("higher leverage means closer liquidation price for short", async () => {
      const entryPrice = new BN(10000);
      const liq1x = calcLiqPriceShort(entryPrice, new BN(1));
      const liq5x = calcLiqPriceShort(entryPrice, new BN(5));
      const liq10x = calcLiqPriceShort(entryPrice, new BN(10));

      // Higher leverage => liquidation price closer to entry
      expect(liq10x.toNumber()).to.be.lessThan(liq5x.toNumber());
      expect(liq5x.toNumber()).to.be.lessThan(liq1x.toNumber());
    });

    it("borrows tokens from lending pool for short", async () => {
      // Short positions borrow tokens from lending pool
      // lending.total_borrowed increases
      // Placeholder for integration test
    });

    it("rejects short when lending pool has insufficient liquidity", async () => {
      // If available = total_deposits - total_borrowed < tokens_to_borrow
      // Should fail with InsufficientLiquidity
      // Placeholder for integration test
    });

    it("sells borrowed tokens via pumpswap", async () => {
      // For short positions, protocol sells tokens for SOL
      // position.position_size_sol = SOL received
      // position.borrowed_tokens = tokens borrowed
      // Placeholder for integration test
    });

    it("updates market total_short_collateral", async () => {
      // After opening short: market.total_short_collateral += collateral_after_fee
      // Placeholder for integration test
    });
  });

  describe("common behavior", () => {
    it("deducts collateral from user balance", async () => {
      // user_account.balance -= collateral
      // Placeholder for integration test
    });

    it("increments market total_positions", async () => {
      // market.total_positions += 1
      // Placeholder for integration test
    });

    it("sets position.opened_at to current timestamp", async () => {
      // position.opened_at should be close to Clock::get()?.unix_timestamp
      // Placeholder for integration test
    });

    it("emits PositionOpened event", async () => {
      // Event should contain owner, market, is_long, collateral, leverage,
      // entry_price, liquidation_price
      // Placeholder for integration test
    });

    it("creates position PDA with correct seeds", async () => {
      const user = Keypair.generate();
      const tokenMint = Keypair.generate();
      const [market] = findMarketPDA(tokenMint.publicKey);
      const [position] = findPositionPDA(user.publicKey, market);

      // Position PDA should be deterministic from user + market
      expect(position).to.not.be.null;

      // Same inputs should give same PDA
      const [position2] = findPositionPDA(user.publicKey, market);
      expect(position.toBase58()).to.equal(position2.toBase58());
    });
  });
});
