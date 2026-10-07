# 🔥 FlameFlip — Flame Vanilla Arcade

A fan-made, provably-fair style arcade for the **flamevannila.eu** Minecraft community,
inspired by modern casino-arcade sites. Built as a **static site** — plain HTML/CSS/JS,
no build step, no dependencies, no server. Everything runs in the browser and saves to
`localStorage`.

> **Coins are in-game Minecraft currency only — not real money.** Play for fun.

## Run it

Open the page in a browser (the file is `flameflip/flameflip.html`). For a local server:

```bash
cd flameflip
python -m http.server 8123 --bind 127.0.0.1
# → http://127.0.0.1:8123/flameflip.html
```

### Free hosting

- **GitHub Pages** — push the `flameflip/` folder to a repo, enable Pages on it.
- **Netlify / Cloudflare Pages** — drag-and-drop the folder, done.

## Sign-in & username

You sign in with your **exact flamevannila.eu Minecraft username** (3–16 letters,
numbers or underscores). Deposits and withdrawals are matched against that name, so
payments reach the right player. The withdrawal modal locks the name to your signed-in
account — you cannot send someone else's coins to another username.

## The games

| Game | Payout | Edge |
|---|---|---|
| **Coinflip** | 1.98× on heads/tails | 1% |
| **Upgrader** | Your chosen multiplier (1.01×–1000×), win chance = 96% ÷ multiplier | 4% |
| **Blackjack** | 1× win / 3:2 blackjack, dealer stands on 17, 6-deck shoe per hand | ≈ 2% |
| **Limbo** | Roll = 96% ÷ float; win if the roll reaches your target (up to 1,000,000×) | 4% |
| **Mines** | 5×5 grid, 1–24 bombs; multiplier after n gems = C(25,n) ÷ C(25−bombs,n) × 0.99 | 1% |

## Deposits (in-game → site)

1. Join `flamevannila.eu`.
2. **Pay `washerecookie` the amount you want** with `/pay washerecookie <amount>`
   (the deposit modal copies the command for you).
3. Type the amount you paid (min 1,000 / max **50,000,000** per deposit) and click
   **I've paid**.
4. A **30-second** verification countdown runs, then the coins are credited.

Pending deposits survive a page refresh — the countdown resumes where it left off.

## Withdrawals (site → in-game)

In the Withdraw modal your signed-in username and the amount are POSTed as a formatted
request (user, amount, ETA, balance) to a **Discord webhook**, where staff pay you
in-game. Rules:

- **Max 5,000,000 (5m) per withdrawal.**
- Coins **arrive within 10–30 minutes** of the request.
- The request is only counted (coins deducted) if the webhook accepts it.

> ⚠️ The webhook URLs live in the client-side config (`WITHDRAW_WEBHOOK` and
> `PROMO_WEBHOOK` in `js/app.js`), so anyone can read them and post to your channels.
> If you get spam, delete/recreate the webhooks in your Discord channel settings and
> paste the new URLs into the config. For stronger protection, proxy them through a
> tiny server (or a Cloudflare Worker) instead.

## Promo codes

The **Promo** button in the navbar opens the redemption modal:

- `COOKIE412` → **5,000** starting coins.
- Any other code → **1,000** coins.
- Each code is redeemable **once per player** (tracked in `localStorage`).
- Every redemption POSTs an embed (username, code, reward) to the promo webhook so
  staff can see who claimed what.

Codes are case-insensitive; redemption requires being signed in with your exact MC
username.

## Contact

The **Contact** button in the navbar shows the owner's handles with one-tap copy:

- **cookiemonke2** on Discord
- **cookie412** in-game on flamevannila.eu

## Fairness

Every result derives from `HMAC_SHA256(serverSeed, clientSeed:label)`:

- first 4 bytes → a float in [0, 1) → coinflip side / upgrader roll / limbo roll
- mines: one float per candidate bomb tile, label `<nonce>:m:<i>`
- blackjack shuffles a fresh 6-deck shoe with one float per Fisher–Yates swap step

The server seed is committed via its SHA-256 hash up front. The **Fairness page** lets
you change the client seed, rotate (reveal) the server seed, and verify any past bet
for every game. Since this is a browser-only fan site, the "server" is your own
localStorage — the math is real, the stakes are in-game coins.

## Tweaking things

All knobs live at the top of `js/app.js` (`CONFIG`):

```js
SERVER: 'flamevannila.eu',     // server shown in the deposit modal
PAYEE: 'washerecookie',        // /pay target
WITHDRAW_WEBHOOK: 'https://discord.com/api/webhooks/…',  // withdrawal requests
PROMO_WEBHOOK: 'https://discord.com/api/webhooks/…',     // promo notifications
PROMO_MAIN_CODE: 'COOKIE412',  // main promo code
PROMO_MAIN_REWARD: 5000,       // reward for the main code
PROMO_DEFAULT_REWARD: 1000,    // reward for any other code
WITHDRAW_MAX: 5000000,         // 5m cap per withdrawal
DEPOSIT_MIN: 1000,
DEPOSIT_MAX: 50000000,         // 50m cap per deposit
DEPOSIT_DELAY_MS: 30000,       // 30s credit delay
BONUS_COOLDOWN_MS: 20 * 60 * 60 * 1000,
KEY: 'flameflip-state-v1'      // localStorage key — bump to wipe all saves
```

Contact handles, game copy, edges, and bonus size live in the same files — search for
them in `js/app.js` and `js/games/*`.

## Files

```
flameflip/
├── flameflip.html      app shell, modals, SVG icons
├── css/style.css       flame theme
└── js/
    ├── fair.js         SHA-256 / HMAC / provably-fair math (dependency-free)
    ├── app.js          state, routing, deposit/withdraw (Discord webhooks), promo, chat, ticker
    └── games/
        ├── coinflip.js
        ├── upgrader.js
        ├── blackjack.js
        ├── limbo.js
        └── mines.js
```

## Disclaimer

Unofficial fan project. Not affiliated with Mojang, Microsoft, or flamevannila.eu.
No real-money gambling takes place on this site; balances are browser-local values
and exist for entertainment only.
