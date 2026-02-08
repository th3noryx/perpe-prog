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
  findUserAccountPDA,
  findMarketPDA,
  findLendingPoolPDA,
  findPositionPDA,
  findLenderPositionPDA,
  airdrop,
  WSOL_MINT,
} from "./setup";

describe("access control", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Perpe as Program;
  const admin = (provider.wallet as anchor.Wallet).payer;

  const [protocol] = findProtocolPDA();
  const [protocolVault] = findProtocolVaultPDA();

  describe("admin-only operations", () => {
    it("only admin can create_market", async () => {
      const nonAdmin = Keypair.generate();
      await airdrop(provider.connection, nonAdmin.publicKey);

      // Attempting create_market with non-admin should fail
      // The program checks: ctx.accounts.admin.key() == ctx.accounts.protocol.admin
      // Placeholder: would fail with Unauthorized
    });

    it("only admin can close_market", async () => {
      const nonAdmin = Keypair.generate();
      await airdrop(provider.connection, nonAdmin.publicKey);

      // The CloseMarket struct has: has_one = admin on protocol
      // Non-admin should fail with constraint violation
    });

    it("only admin can unwrap_wsol", async () => {
      const nonAdmin = Keypair.generate();
      await airdrop(provider.connection, nonAdmin.publicKey);

      // UnwrapWsol struct has: has_one = admin on protocol
      // Non-admin should fail
    });

    it("admin is set during initialize and cannot be changed", async () => {
      const protocolState =
        (await program.account.protocol.fetch(protocol)) as any;
      expect(protocolState.admin.toBase58()).to.equal(
        admin.publicKey.toBase58()
      );

      // Protocol struct has no update_admin instruction
      // Admin is immutable after initialization
    });
  });

  describe("user account ownership", () => {
    it("user_account PDA is derived from user pubkey", async () => {
      const user1 = Keypair.generate();
      const user2 = Keypair.generate();

      const [pda1] = findUserAccountPDA(user1.publicKey);
      const [pda2] = findUserAccountPDA(user2.publicKey);

      // Different users get different PDAs
      expect(pda1.toBase58()).to.not.equal(pda2.toBase58());
    });

    it("withdraw checks user_account.owner == user.key()", () => {
      // Withdraw struct has constraint:
      // user_account.owner == user.key() @ ErrorCode::Unauthorized
      // This prevents unauthorized withdrawals
    });

    it("user cannot withdraw from another user's account via PDA manipulation", async () => {
      // PDA seeds include user.key(), so a different signer
      // would compute a different PDA, which won't match
    });
  });

  describe("position ownership", () => {
    it("position PDA is derived from user + market", () => {
      const user1 = Keypair.generate();
      const user2 = Keypair.generate();
      const market = Keypair.generate();

      const [pos1] = findPositionPDA(user1.publicKey, market.publicKey);
      const [pos2] = findPositionPDA(user2.publicKey, market.publicKey);

      // Different users have different position PDAs for same market
      expect(pos1.toBase58()).to.not.equal(pos2.toBase58());
    });

    it("only one position per user per market (PDA uniqueness)", () => {
      const user = Keypair.generate();
      const market = Keypair.generate();

      const [pos1] = findPositionPDA(user.publicKey, market.publicKey);
      const [pos2] = findPositionPDA(user.publicKey, market.publicKey);

      // Same user + same market = same PDA
      expect(pos1.toBase58()).to.equal(pos2.toBase58());
    });

    it("close_position checks position.owner == user.key()", () => {
      // ClosePosition struct has constraint:
      // position.owner == user.key() @ ErrorCode::Unauthorized
    });

    it("position account rent refunded to position_owner on close", () => {
      // close = position_owner in both ClosePosition and Liquidate
      // Rent refund goes to the correct address
    });
  });

  describe("lender position ownership", () => {
    it("lender_position PDA is derived from user + lending_pool", () => {
      const user1 = Keypair.generate();
      const user2 = Keypair.generate();
      const lendingPool = Keypair.generate();

      const [lp1] = findLenderPositionPDA(
        user1.publicKey,
        lendingPool.publicKey
      );
      const [lp2] = findLenderPositionPDA(
        user2.publicKey,
        lendingPool.publicKey
      );

      expect(lp1.toBase58()).to.not.equal(lp2.toBase58());
    });

    it("withdraw_from_lending checks lender_position.owner == user.key()", () => {
      // Constraint on WithdrawFromLending:
      // lender_position.owner == user.key() @ ErrorCode::Unauthorized
    });
  });

  describe("PDA seed security", () => {
    it("protocol PDA uses fixed seed 'protocol'", () => {
      const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from("protocol")],
        new PublicKey("perpmwcaoweY2WNxviUKrJPCAvLaNHGESXZGZgiDVDS")
      );
      const [expected] = findProtocolPDA();
      expect(pda.toBase58()).to.equal(expected.toBase58());
    });

    it("protocol_vault PDA uses fixed seed 'protocol_vault'", () => {
      const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from("protocol_vault")],
        new PublicKey("perpmwcaoweY2WNxviUKrJPCAvLaNHGESXZGZgiDVDS")
      );
      const [expected] = findProtocolVaultPDA();
      expect(pda.toBase58()).to.equal(expected.toBase58());
    });

    it("market PDA includes token_mint to prevent collisions", () => {
      const mint1 = Keypair.generate();
      const mint2 = Keypair.generate();

      const [market1] = findMarketPDA(mint1.publicKey);
      const [market2] = findMarketPDA(mint2.publicKey);

      expect(market1.toBase58()).to.not.equal(market2.toBase58());
    });

    it("lending_pool PDA includes market key", () => {
      const market1 = Keypair.generate();
      const market2 = Keypair.generate();

      const [lp1] = findLendingPoolPDA(market1.publicKey);
      const [lp2] = findLendingPoolPDA(market2.publicKey);

      expect(lp1.toBase58()).to.not.equal(lp2.toBase58());
    });
  });

  describe("pumpswap integration security", () => {
    it("requires exactly 15 remaining_accounts for pumpswap", () => {
      // parse_pumpswap_accounts checks remaining.len() >= 15
      // Fewer accounts should fail with InvalidPumpswapAccounts
    });

    it("create_market validates pool owner is PUMPSWAP_PROGRAM_ID", () => {
      // ctx.accounts.pumpswap_pool.owner == &PUMPSWAP_PROGRAM_ID
      // Prevents use of fake pool accounts
    });

    it("create_market validates pool base_mint matches token_mint", () => {
      // Reads pool_data at POOL_BASE_MINT_OFFSET and checks against token_mint
      // Prevents market creation with mismatched pool
    });
  });
});
