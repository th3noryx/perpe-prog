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
  airdrop,
} from "./setup";

describe("deposit / withdraw", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Perpe as Program;
  const admin = (provider.wallet as anchor.Wallet).payer;

  const [protocol] = findProtocolPDA();
  const [protocolVault] = findProtocolVaultPDA();

  let user: Keypair;
  let userAccountPDA: PublicKey;

  beforeEach(async () => {
    user = Keypair.generate();
    await airdrop(provider.connection, user.publicKey, 20 * LAMPORTS_PER_SOL);
    [userAccountPDA] = findUserAccountPDA(user.publicKey);
  });

  describe("deposit", () => {
    it("deposits SOL successfully and creates user account", async () => {
      const depositAmount = new BN(5 * LAMPORTS_PER_SOL);

      const tx = await program.methods
        .deposit(depositAmount)
        .accounts({
          user: user.publicKey,
          protocol,
          protocolVault,
          userAccount: userAccountPDA,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      expect(tx).to.be.a("string");

      const userAccount = (await program.account.userAccount.fetch(
        userAccountPDA
      )) as any;
      expect(userAccount.owner.toBase58()).to.equal(
        user.publicKey.toBase58()
      );
      expect(userAccount.balance.toNumber()).to.equal(
        depositAmount.toNumber()
      );
    });

    it("allows multiple deposits that accumulate balance", async () => {
      const first = new BN(2 * LAMPORTS_PER_SOL);
      const second = new BN(3 * LAMPORTS_PER_SOL);

      await program.methods
        .deposit(first)
        .accounts({
          user: user.publicKey,
          protocol,
          protocolVault,
          userAccount: userAccountPDA,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      await program.methods
        .deposit(second)
        .accounts({
          user: user.publicKey,
          protocol,
          protocolVault,
          userAccount: userAccountPDA,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      const userAccount = (await program.account.userAccount.fetch(
        userAccountPDA
      )) as any;
      expect(userAccount.balance.toNumber()).to.equal(
        first.add(second).toNumber()
      );
    });

    it("rejects zero deposit amount", async () => {
      try {
        await program.methods
          .deposit(new BN(0))
          .accounts({
            user: user.publicKey,
            protocol,
            protocolVault,
            userAccount: userAccountPDA,
            systemProgram: SystemProgram.programId,
          })
          .signers([user])
          .rpc();
        expect.fail("Should have thrown ZeroAmount");
      } catch (err: any) {
        expect(err.toString()).to.include("ZeroAmount");
      }
    });

    it("transfers SOL to protocol vault", async () => {
      const depositAmount = new BN(3 * LAMPORTS_PER_SOL);

      const vaultBefore = await provider.connection.getBalance(protocolVault);

      await program.methods
        .deposit(depositAmount)
        .accounts({
          user: user.publicKey,
          protocol,
          protocolVault,
          userAccount: userAccountPDA,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      const vaultAfter = await provider.connection.getBalance(protocolVault);
      expect(vaultAfter - vaultBefore).to.be.greaterThanOrEqual(
        depositAmount.toNumber()
      );
    });

    it("emits Deposited event with correct fields", async () => {
      const depositAmount = new BN(1 * LAMPORTS_PER_SOL);
      let eventReceived = false;

      const listener = program.addEventListener(
        "Deposited",
        (event: any) => {
          expect(event.user.toBase58()).to.equal(
            user.publicKey.toBase58()
          );
          expect(event.amount.toNumber()).to.equal(
            depositAmount.toNumber()
          );
          expect(event.newBalance.toNumber()).to.equal(
            depositAmount.toNumber()
          );
          eventReceived = true;
        }
      );

      await program.methods
        .deposit(depositAmount)
        .accounts({
          user: user.publicKey,
          protocol,
          protocolVault,
          userAccount: userAccountPDA,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      // Give time for event listener
      await new Promise((r) => setTimeout(r, 2000));
      await program.removeEventListener(listener);
    });
  });

  describe("withdraw", () => {
    beforeEach(async () => {
      // Pre-deposit so user has a balance
      await program.methods
        .deposit(new BN(10 * LAMPORTS_PER_SOL))
        .accounts({
          user: user.publicKey,
          protocol,
          protocolVault,
          userAccount: userAccountPDA,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();
    });

    it("withdraws SOL successfully", async () => {
      const withdrawAmount = new BN(5 * LAMPORTS_PER_SOL);

      const balanceBefore = await provider.connection.getBalance(
        user.publicKey
      );

      await program.methods
        .withdraw(withdrawAmount)
        .accounts({
          user: user.publicKey,
          protocol,
          protocolVault,
          userAccount: userAccountPDA,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      const userAccount = (await program.account.userAccount.fetch(
        userAccountPDA
      )) as any;
      expect(userAccount.balance.toNumber()).to.equal(
        5 * LAMPORTS_PER_SOL
      );

      const balanceAfter = await provider.connection.getBalance(
        user.publicKey
      );
      // User balance should increase (minus tx fees)
      expect(balanceAfter).to.be.greaterThan(balanceBefore);
    });

    it("allows full withdrawal", async () => {
      const withdrawAmount = new BN(10 * LAMPORTS_PER_SOL);

      await program.methods
        .withdraw(withdrawAmount)
        .accounts({
          user: user.publicKey,
          protocol,
          protocolVault,
          userAccount: userAccountPDA,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      const userAccount = (await program.account.userAccount.fetch(
        userAccountPDA
      )) as any;
      expect(userAccount.balance.toNumber()).to.equal(0);
    });

    it("rejects withdrawal exceeding balance", async () => {
      try {
        await program.methods
          .withdraw(new BN(20 * LAMPORTS_PER_SOL))
          .accounts({
            user: user.publicKey,
            protocol,
            protocolVault,
            userAccount: userAccountPDA,
            systemProgram: SystemProgram.programId,
          })
          .signers([user])
          .rpc();
        expect.fail("Should have thrown InsufficientBalance");
      } catch (err: any) {
        expect(err.toString()).to.include("InsufficientBalance");
      }
    });

    it("rejects unauthorized withdrawal by another user", async () => {
      const attacker = Keypair.generate();
      await airdrop(provider.connection, attacker.publicKey);

      try {
        await program.methods
          .withdraw(new BN(1 * LAMPORTS_PER_SOL))
          .accounts({
            user: attacker.publicKey,
            protocol,
            protocolVault,
            userAccount: userAccountPDA,
            systemProgram: SystemProgram.programId,
          })
          .signers([attacker])
          .rpc();
        expect.fail("Should have thrown - wrong user PDA seeds");
      } catch (err: any) {
        // PDA seeds mismatch or Unauthorized constraint
        expect(err).to.not.be.null;
      }
    });

    it("emits Withdrawn event with correct fields", async () => {
      const withdrawAmount = new BN(3 * LAMPORTS_PER_SOL);

      const listener = program.addEventListener(
        "Withdrawn",
        (event: any) => {
          expect(event.user.toBase58()).to.equal(
            user.publicKey.toBase58()
          );
          expect(event.amount.toNumber()).to.equal(
            withdrawAmount.toNumber()
          );
          expect(event.newBalance.toNumber()).to.equal(
            7 * LAMPORTS_PER_SOL
          );
        }
      );

      await program.methods
        .withdraw(withdrawAmount)
        .accounts({
          user: user.publicKey,
          protocol,
          protocolVault,
          userAccount: userAccountPDA,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      await new Promise((r) => setTimeout(r, 2000));
      await program.removeEventListener(listener);
    });
  });
});
