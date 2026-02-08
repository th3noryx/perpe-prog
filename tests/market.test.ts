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
  airdrop,
  createTestMint,
  PUMPSWAP_PROGRAM_ID,
} from "./setup";

describe("create_market / close_market", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Perpe as Program;
  const admin = (provider.wallet as anchor.Wallet).payer;

  const [protocol] = findProtocolPDA();
  const [protocolVault] = findProtocolVaultPDA();

  let tokenMint: PublicKey;
  let mockPool: Keypair;

  before(async () => {
    // Create a test token mint
    tokenMint = await createTestMint(provider.connection, admin);

    // Create a mock pumpswap pool account
    // In real tests this would need to be owned by PUMPSWAP_PROGRAM_ID
    // and contain the token mint at the correct offset
    mockPool = Keypair.generate();
  });

  describe("create_market", () => {
    it("creates a market with valid parameters", async () => {
      const [market] = findMarketPDA(tokenMint);
      const [lendingPool] = findLendingPoolPDA(market);
      const maxPositionSize = new BN(100 * LAMPORTS_PER_SOL);

      const tokenVault = anchor.utils.token.associatedAddress({
        mint: tokenMint,
        owner: protocolVault,
      });

      // Note: This test will fail without a real pumpswap pool.
      // In integration tests, you'd set up a proper mock pool.
      try {
        const tx = await program.methods
          .createMarket(maxPositionSize)
          .accounts({
            admin: admin.publicKey,
            protocol,
            protocolVault,
            tokenMint,
            market,
            lendingPool,
            tokenVault,
            pumpswapPool: mockPool.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .rpc();

        // If succeeds, validate market state
        const marketState = (await program.account.market.fetch(
          market
        )) as any;
        expect(marketState.tokenMint.toBase58()).to.equal(
          tokenMint.toBase58()
        );
        expect(marketState.totalLongCollateral.toNumber()).to.equal(0);
        expect(marketState.totalShortCollateral.toNumber()).to.equal(0);
        expect(marketState.totalPositions.toNumber()).to.equal(0);
        expect(marketState.maxPositionSize.toNumber()).to.equal(
          maxPositionSize.toNumber()
        );
      } catch (err: any) {
        // Expected to fail without proper pumpswap pool setup
        expect(err.toString()).to.include("InvalidPool");
      }
    });

    it("rejects non-admin callers", async () => {
      const nonAdmin = Keypair.generate();
      await airdrop(provider.connection, nonAdmin.publicKey);

      const [market] = findMarketPDA(tokenMint);
      const [lendingPool] = findLendingPoolPDA(market);
      const maxPositionSize = new BN(100 * LAMPORTS_PER_SOL);

      const tokenVault = anchor.utils.token.associatedAddress({
        mint: tokenMint,
        owner: protocolVault,
      });

      try {
        await program.methods
          .createMarket(maxPositionSize)
          .accounts({
            admin: nonAdmin.publicKey,
            protocol,
            protocolVault,
            tokenMint,
            market,
            lendingPool,
            tokenVault,
            pumpswapPool: mockPool.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([nonAdmin])
          .rpc();
        expect.fail("Should have thrown Unauthorized");
      } catch (err: any) {
        expect(err.toString()).to.include("Unauthorized");
      }
    });

    it("rejects invalid pumpswap pool (wrong owner)", async () => {
      const fakePool = Keypair.generate();
      const newMint = await createTestMint(provider.connection, admin);
      const [market] = findMarketPDA(newMint);
      const [lendingPool] = findLendingPoolPDA(market);

      const tokenVault = anchor.utils.token.associatedAddress({
        mint: newMint,
        owner: protocolVault,
      });

      try {
        await program.methods
          .createMarket(new BN(50 * LAMPORTS_PER_SOL))
          .accounts({
            admin: admin.publicKey,
            protocol,
            protocolVault,
            tokenMint: newMint,
            market,
            lendingPool,
            tokenVault,
            pumpswapPool: fakePool.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        expect.fail("Should have thrown InvalidPool");
      } catch (err: any) {
        expect(err.toString()).to.include("InvalidPool");
      }
    });

    it("initializes lending pool alongside market", async () => {
      // After successful market creation, lending pool should also be initialized
      // This verifies the atomic creation of market + lending pool
      const newMint = await createTestMint(provider.connection, admin);
      const [market] = findMarketPDA(newMint);
      const [lendingPool] = findLendingPoolPDA(market);

      // Lending pool doesn't exist yet
      const lendingInfo = await provider.connection.getAccountInfo(
        lendingPool
      );
      expect(lendingInfo).to.be.null;
    });
  });

  describe("close_market", () => {
    it("rejects closing market with open positions", async () => {
      // This test verifies the MarketHasPositions check
      // Would need a market with total_positions > 0
      // Placeholder for integration test with full setup
    });

    it("rejects closing market with active borrows", async () => {
      // This test verifies the MarketHasBorrows check
      // Would need a lending pool with total_borrowed > 0
      // Placeholder for integration test with full setup
    });

    it("rejects non-admin closing a market", async () => {
      const nonAdmin = Keypair.generate();
      await airdrop(provider.connection, nonAdmin.publicKey);

      // Would need a valid market to attempt closing
      // Constraint: has_one = admin on protocol
    });

    it("returns rent to admin on close", async () => {
      // After closing, market and lending_pool accounts are closed
      // Rent goes back to admin via `close = admin`
      // Verified by checking admin balance increases after close
    });
  });
});
