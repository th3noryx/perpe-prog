import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorProvider, BN } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Connection,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createMint,
  createAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";

// ============ Constants matching the on-chain program ============

export const PROGRAM_ID = new PublicKey(
  "perpmwcaoweY2WNxviUKrJPCAvLaNHGESXZGZgiDVDS"
);
export const PUMPSWAP_PROGRAM_ID = new PublicKey(
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"
);
export const WSOL_MINT = new PublicKey(
  "So11111111111111111111111111111111111111112"
);

export const MAX_LEVERAGE = 10;
export const LIQUIDATION_THRESHOLD_BPS = 7000;
export const LIQUIDATOR_REWARD_BPS = 500;
export const PROTOCOL_FEE_BPS = 30;
export const BPS_DENOMINATOR = 10_000;
export const PRECISION = 1_000_000_000_000;

// ============ PDA Derivation Helpers ============

export function findProtocolPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("protocol")],
    PROGRAM_ID
  );
}

export function findProtocolVaultPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("protocol_vault")],
    PROGRAM_ID
  );
}

export function findMarketPDA(tokenMint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("market"), tokenMint.toBuffer()],
    PROGRAM_ID
  );
}

export function findLendingPoolPDA(market: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("lending_pool"), market.toBuffer()],
    PROGRAM_ID
  );
}

export function findUserAccountPDA(user: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("user_account"), user.toBuffer()],
    PROGRAM_ID
  );
}

export function findPositionPDA(
  user: PublicKey,
  market: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("position"), user.toBuffer(), market.toBuffer()],
    PROGRAM_ID
  );
}

export function findLenderPositionPDA(
  user: PublicKey,
  lendingPool: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("lender"), user.toBuffer(), lendingPool.toBuffer()],
    PROGRAM_ID
  );
}

// ============ Account State Types ============

export interface ProtocolState {
  admin: PublicKey;
  bump: number;
  vaultBump: number;
}

export interface MarketState {
  tokenMint: PublicKey;
  pumpswapPool: PublicKey;
  totalLongCollateral: BN;
  totalShortCollateral: BN;
  totalPositions: BN;
  maxPositionSize: BN;
  bump: number;
}

export interface LendingPoolState {
  market: PublicKey;
  tokenMint: PublicKey;
  totalDeposits: BN;
  totalBorrowed: BN;
  totalShares: BN;
  bump: number;
}

export interface UserAccountState {
  owner: PublicKey;
  balance: BN;
  bump: number;
}

export interface PositionState {
  owner: PublicKey;
  market: PublicKey;
  isLong: boolean;
  collateral: BN;
  leverage: BN;
  entryPrice: BN;
  liquidationPrice: BN;
  tokenAmount: BN;
  positionSizeSol: BN;
  borrowedTokens: BN;
  openedAt: BN;
  bump: number;
}

export interface LenderPositionState {
  owner: PublicKey;
  lendingPool: PublicKey;
  shares: BN;
  bump: number;
}

// ============ Test Context Setup ============

export interface TestContext {
  provider: AnchorProvider;
  program: Program;
  admin: Keypair;
  protocol: PublicKey;
  protocolBump: number;
  protocolVault: PublicKey;
  vaultBump: number;
}

export async function setupTestContext(): Promise<TestContext> {
  const provider = AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Perpe as Program;
  const admin = (provider.wallet as anchor.Wallet).payer;

  const [protocol, protocolBump] = findProtocolPDA();
  const [protocolVault, vaultBump] = findProtocolVaultPDA();

  return {
    provider,
    program,
    admin,
    protocol,
    protocolBump,
    protocolVault,
    vaultBump,
  };
}

// ============ Airdrop Helper ============

export async function airdrop(
  connection: Connection,
  address: PublicKey,
  amount: number = 10 * LAMPORTS_PER_SOL
): Promise<void> {
  const sig = await connection.requestAirdrop(address, amount);
  const latestBlockhash = await connection.getLatestBlockhash();
  await connection.confirmTransaction({
    signature: sig,
    blockhash: latestBlockhash.blockhash,
    lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
  });
}

// ============ Token Helpers ============

export async function createTestMint(
  connection: Connection,
  payer: Keypair,
  decimals: number = 6
): Promise<PublicKey> {
  return await createMint(
    connection,
    payer,
    payer.publicKey,
    null,
    decimals
  );
}

export async function createAndFundTokenAccount(
  connection: Connection,
  payer: Keypair,
  mint: PublicKey,
  owner: PublicKey,
  amount: number
): Promise<PublicKey> {
  const ata = await createAssociatedTokenAccount(
    connection,
    payer,
    mint,
    owner
  );
  await mintTo(connection, payer, mint, ata, payer, amount);
  return ata;
}

// ============ Math Helpers (mirrors on-chain logic) ============

export function calcLiqPriceLong(entryPrice: BN, leverage: BN): BN {
  const dropBps = new BN(LIQUIDATION_THRESHOLD_BPS).div(leverage);
  return entryPrice
    .mul(new BN(BPS_DENOMINATOR).sub(dropBps))
    .div(new BN(BPS_DENOMINATOR));
}

export function calcLiqPriceShort(entryPrice: BN, leverage: BN): BN {
  const riseBps = new BN(LIQUIDATION_THRESHOLD_BPS).div(leverage);
  return entryPrice
    .mul(new BN(BPS_DENOMINATOR).add(riseBps))
    .div(new BN(BPS_DENOMINATOR));
}

export function calcFee(amount: BN): BN {
  return amount.mul(new BN(PROTOCOL_FEE_BPS)).div(new BN(BPS_DENOMINATOR));
}

export function calcPositionSize(collateral: BN, leverage: BN): BN {
  const fee = calcFee(collateral);
  return collateral.sub(fee).mul(leverage);
}

export function calcLendingShares(
  amount: BN,
  totalDeposits: BN,
  totalShares: BN
): BN {
  if (totalDeposits.isZero()) return amount;
  return amount.mul(totalShares).div(totalDeposits);
}

export function calcLendingTokens(
  shares: BN,
  totalDeposits: BN,
  totalShares: BN
): BN {
  return shares.mul(totalDeposits).div(totalShares);
}

// ============ Assertion Helpers ============

export function expectError(error: any, errorCode: string): boolean {
  const errMsg = error.toString();
  return (
    errMsg.includes(errorCode) ||
    errMsg.includes(`Error Code: ${errorCode}`)
  );
}

export function bnEqual(a: BN, b: BN): boolean {
  return a.eq(b);
}

// ============ Wait helper ============

export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
