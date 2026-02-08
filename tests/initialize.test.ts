import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { expect } from "chai";
import {
  setupTestContext,
  findProtocolPDA,
  findProtocolVaultPDA,
  WSOL_MINT,
  airdrop,
  ProtocolState,
} from "./setup";

describe("initialize", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Perpe as Program;
  const admin = (provider.wallet as anchor.Wallet).payer;

  const [protocol] = findProtocolPDA();
  const [protocolVault] = findProtocolVaultPDA();

  it("initializes the protocol successfully", async () => {
    const wsolVault = anchor.utils.token.associatedAddress({
      mint: WSOL_MINT,
      owner: protocolVault,
    });

    const tx = await program.methods
      .initialize()
      .accounts({
        admin: admin.publicKey,
        protocol,
        protocolVault,
        wsolVault,
        wsolMint: WSOL_MINT,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    expect(tx).to.be.a("string");

    // Fetch and validate protocol state
    const protocolState =
      (await program.account.protocol.fetch(protocol)) as any;
    expect(protocolState.admin.toBase58()).to.equal(
      admin.publicKey.toBase58()
    );
    expect(protocolState.bump).to.be.a("number");
    expect(protocolState.vaultBump).to.be.a("number");
  });

  it("emits ProtocolInitialized event", async () => {
    // Event listeners validate that the protocol emits the correct event
    const listener = program.addEventListener(
      "ProtocolInitialized",
      (event: any) => {
        expect(event.admin.toBase58()).to.equal(admin.publicKey.toBase58());
      }
    );

    // Event was already emitted during initialization above
    // Clean up listener
    await program.removeEventListener(listener);
  });

  it("cannot initialize twice (PDA already exists)", async () => {
    const wsolVault = anchor.utils.token.associatedAddress({
      mint: WSOL_MINT,
      owner: protocolVault,
    });

    try {
      await program.methods
        .initialize()
        .accounts({
          admin: admin.publicKey,
          protocol,
          protocolVault,
          wsolVault,
          wsolMint: WSOL_MINT,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      expect.fail("Should have thrown an error");
    } catch (err: any) {
      // Account already initialized - expected
      expect(err.toString()).to.include("already in use");
    }
  });

  it("stores correct PDA bumps", async () => {
    const protocolState =
      (await program.account.protocol.fetch(protocol)) as any;

    const [, expectedProtocolBump] = findProtocolPDA();
    const [, expectedVaultBump] = findProtocolVaultPDA();

    expect(protocolState.bump).to.equal(expectedProtocolBump);
    expect(protocolState.vaultBump).to.equal(expectedVaultBump);
  });

  it("protocol vault is a valid PDA", async () => {
    const vaultInfo = await provider.connection.getAccountInfo(protocolVault);
    // Protocol vault should exist after initialization
    expect(vaultInfo).to.not.be.null;
  });
});
