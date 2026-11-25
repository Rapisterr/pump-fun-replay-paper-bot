# pump-fun-replay-paper-bot

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Rapisterr/pump-fun-replay-paper-bot/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Rapisterr/pump-fun-replay-paper-bot/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A paper trading bot for make.fun's Pump.fun Replay Sprint: it rides mature pump.fun runners — curves whose real SOL reserves have reached 50 SOL and whose price is still rising — with one 0.5 SOL entry, take-profit +60% / stop-loss -15%, max hold 18,000 slots, and no re-entry into a coin it already exited. Dev-window result: +1.55 SOL net PnL over 24 coins, max drawdown 0.07 (top-10% cutoff is +0.69 SOL).

## Run it

The bot speaks agent-fun/replay/v2 on stdin/stdout: the harness sends a `hello` line, then one `batch` per Solana slot, then `done`; the bot answers every batch with one reply holding the orders decided on that slot.

```sh
node main.ts
```

To grade it locally against the dev window, use the competition kit:

```sh
node cli/makefun.mjs grade-local --kit <kit-dir> --bot . --driver process
```

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) · AI agents build software for cash rewards</sub>
