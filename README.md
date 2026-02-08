# perpmeme

Open-source perpetual trading engine for memecoins on Solana.

## How it works

**perpmeme** lets users open leveraged long/short positions on any token that has a PumpSwap liquidity pool. The entire system runs on-chain via a single Solana program with no off-chain order book or oracle dependency — prices are derived directly from PumpSwap AMM pool reserves.

### Core mechanics

- **Deposit/Withdraw** — Users deposit SOL into a protocol-managed account (PDA vault). This balance is used as collateral for trading.
- **Open Position** — Pick a token market, choose long or short, set collateral amount and leverage (1-10x). The program executes a swap through PumpSwap to establish the position.
  - **Long**: Buys tokens with `collateral * leverage` SOL via PumpSwap. Tokens are held in the protocol vault.
  - **Short**: Borrows tokens from the lending pool, sells them on PumpSwap for SOL. SOL proceeds are held as the position.
- **Close Position** — Reverses the swap. PnL is calculated from the difference and credited/debited to the user's balance.
- **Liquidation** — Anyone can liquidate a position that breaches the liquidation threshold (70% of collateral lost). Liquidators receive a 5% reward from the remaining collateral.
- **Lending** — Liquidity providers deposit tokens into per-market lending pools. These tokens are borrowed by short sellers. LPs earn returns when borrowed tokens are repaid.

### Price calculation

Prices are computed on-chain from PumpSwap pool vault balances:

```
price = (quote_vault_balance * PRECISION) / base_vault_balance
```

Where `PRECISION = 1_000_000_000_000` (1e12). No external oracle is needed.

### Key parameters

| Parameter | Value |
|---|---|
| Max leverage | 10x |
| Liquidation threshold | 70% collateral loss |
| Liquidator reward | 5% of remaining value |
| Protocol fee | 0.3% on open and close |

### On-chain accounts (PDAs)

| Account | Seeds | Description |
|---|---|---|
| Protocol | `["protocol"]` | Global config, admin key, bumps |
| Protocol Vault | `["protocol_vault"]` | Shared SOL vault (PDA signer) |
| User Account | `["user_account", user]` | Per-user SOL balance |
| Market | `["market", token_mint]` | Per-token market config |
| Lending Pool | `["lending_pool", market]` | Token lending pool state |
| Position | `["position", user, market]` | Active trading position |
| Lender Position | `["lender", user, lending_pool]` | LP deposit tracking |

### Instructions

| Instruction | Description |
|---|---|
| `initialize` | Deploy protocol, create global vault |
| `create_market` | Register a new token market (admin only) |
| `deposit` / `withdraw` | Move SOL in/out of user account |
| `deposit_to_lending` / `withdraw_from_lending` | LP token deposits/withdrawals |
| `open_position` | Open a leveraged long or short |
| `close_position` | Close position and settle PnL |
| `liquidate` | Liquidate an underwater position |

## Tech stack

- Rust + Anchor framework
- PumpSwap AMM (for all token swaps)
- Solana mainnet

## License

MIT
