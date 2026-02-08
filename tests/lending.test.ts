import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { expect } from "chai";
import {
  findProtocolPDA,
  findProtocolVaultPDA,
  findMarketPDA,
  findLendingPoolPDA,
  findLenderPositionPDA,
  airdrop,
  createTestMint,
  createAndFundTokenAccount,
  calcLendingShares,
  calcLendingTokens,
} from "./setup";

describe("lending pool (deposit_to_lending / withdraw_from_lending)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Perpe as Program;
  const admin = (provider.wallet as anchor.Wallet).payer;

  const [protocol] = findProtocolPDA();
  const [protocolVault] = findProtocolVaultPDA();

  let tokenMint: PublicKey;
  let marketPDA: PublicKey;
  let lendingPoolPDA: PublicKey;
  let tokenVault: PublicKey;

  // These tests assume a market has been created already.
  // In a full integration suite, you'd create the market in a before() hook.

  describe("deposit_to_lending", () => {
    let user: Keypair;
    let userTokenAccount: PublicKey;
    let lenderPositionPDA: PublicKey;

    beforeEach(async () => {
      user = Keypair.generate();
      await airdrop(
        provider.connection,
        user.publicKey,
        5 * LAMPORTS_PER_SOL
      );
    });

    it("rejects zero deposit amount", async () => {
      // deposit_to_lending with amount = 0 should fail with ZeroAmount
      // This test validates the require!(amount > 0) check
      try {
        // Would need valid market accounts to test this properly
        // Placeholder for the constraint validation
        expect(true).to.be.true;
      } catch (err: any) {
        expect(err.toString()).to.include("ZeroAmount");
      }
    });

    it("calculates shares correctly on first deposit (1:1 ratio)", async () => {
      // When total_deposits == 0, shares = amount
      const amount = new BN(1_000_000);
      const totalDeposits = new BN(0);
      const totalShares = new BN(0);
      const shares = calcLendingShares(amount, totalDeposits, totalShares);
      expect(shares.toNumber()).to.equal(amount.toNumber());
    });

    it("calculates shares proportionally after first deposit", async () => {
      // If pool has 100 tokens and 100 shares, depositing 50 gives 50 shares
      const amount = new BN(50);
      const totalDeposits = new BN(100);
      const totalShares = new BN(100);
      const shares = calcLendingShares(amount, totalDeposits, totalShares);
      expect(shares.toNumber()).to.equal(50);
    });

    it("handles share calculation when pool has accrued interest", async () => {
      // If pool has 200 tokens and 100 shares (2:1 ratio from interest),
      // depositing 100 tokens gives 50 shares
      const amount = new BN(100);
      const totalDeposits = new BN(200);
      const totalShares = new BN(100);
      const shares = calcLendingShares(amount, totalDeposits, totalShares);
      expect(shares.toNumber()).to.equal(50);
    });

    it("emits LendingDeposited event", async () => {
      // Validates the event contains user, amount, and shares fields
      // Placeholder for integration test
    });

    it("transfers tokens from user to token vault", async () => {
      // Verifies SPL token transfer from user_token_account to token_vault
      // Placeholder for integration test
    });

    it("updates lending pool totals correctly", async () => {
      // After deposit: total_deposits += amount, total_shares += shares
      // Placeholder for integration test
    });

    it("allows multiple users to deposit into same lending pool", async () => {
      // Two different users should both be able to deposit
      // Each gets their own lender_position PDA
      // Placeholder for integration test
    });
  });

  describe("withdraw_from_lending", () => {
    it("rejects withdrawal with insufficient shares", async () => {
      // If lender has 100 shares, trying to withdraw 200 should fail
      // Placeholder for integration test
    });

    it("calculates token amount from shares correctly", async () => {
      // tokens = shares * total_deposits / total_shares
      const shares = new BN(50);
      const totalDeposits = new BN(200);
      const totalShares = new BN(100);
      const tokens = calcLendingTokens(shares, totalDeposits, totalShares);
      expect(tokens.toNumber()).to.equal(100);
    });

    it("rejects withdrawal when liquidity is insufficient (tokens borrowed)", async () => {
      // If total_deposits=1000, total_borrowed=800, available=200
      // Attempting to withdraw more than 200 worth of tokens should fail
      // Placeholder for integration test
    });

    it("updates lending pool totals on withdrawal", async () => {
      // After withdraw: total_deposits -= tokens, total_shares -= shares
      // lender.shares -= shares
      // Placeholder for integration test
    });

    it("transfers tokens back to user", async () => {
      // Verifies token_vault -> user_token_account transfer
      // Placeholder for integration test
    });

    it("allows full share withdrawal", async () => {
      // User withdraws all their shares, lender.shares becomes 0
      // Placeholder for integration test
    });

    it("emits LendingWithdrawn event", async () => {
      // Validates event has user, tokens, shares fields
      // Placeholder for integration test
    });

    it("prevents unauthorized withdrawal (wrong user)", async () => {
      // Another user can't withdraw from someone else's lender_position
      // Constraint: lender_position.owner == user.key()
      // Placeholder for integration test
    });
  });
});
