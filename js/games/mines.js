/*
 * FlameFlip — Mines.
 * 5×5 grid, you choose how many bombs (1–24). Each safe tile multiplies your
 * payout. Cash out any time; hitting a bomb loses the bet. Bomb positions come
 * from the provably-fair core (one HMAC float per candidate position).
 *
 * Payout model (1% edge): multiplier after n safe picks =
 *   C(25, n) / C(25 - bombs, n) × 0.99
 */
(function () {
  'use strict';

  window.FFGames = window.FFGames || {};
  window.FFGames.mines = {
    id: 'mines',
    name: 'Mines',
    icon: 'i-shield',
    desc: 'Pick gems, dodge bombs',
    render: function (betSide, stage) {
      var UI = window.FFUI; // lazy: app.js loads last

      betSide.innerHTML =
        '<div class="bet-card">' +
          '<div class="bet-label">Bet amount</div>' +
          '<div class="bet-row"><div class="bet-input-wrap"><svg><use href="#i-coin"/></svg>' +
          '<input type="text" id="mn-bet" inputmode="numeric" placeholder="0"></div>' +
          '<button class="btn-ghost sm" id="mn-max">Max</button></div>' +
          '<div class="half-2x">' +
            '<button class="btn-ghost" id="mn-half">½</button>' +
            '<button class="btn-ghost" id="mn-2x">2×</button>' +
          '</div>' +

          '<div class="side-label">Bombs (difficulty)</div>' +
          '<div class="range-row"><input type="range" id="mn-bombs" min="1" max="24" value="3">' +
          '<div class="range-nums"><span>1 bomb</span><span>24 bombs</span></div></div>' +
          '<div class="up-stat"><span>Current multiplier</span><b id="mn-mult">1.00×</b></div>' +
          '<div class="up-stat"><span>Next gem pays</span><b id="mn-next">—</b></div>' +

          '<button class="btn-brand wide play-btn" id="mn-start">Place bet &amp; start</button>' +
          '<button class="btn-brand wide play-btn" id="mn-cashout" style="display:none;background:linear-gradient(180deg,#7ce8a8,#2ecc71)">Cash out</button>' +
          '<div class="bet-history" id="mn-history"></div>' +
        '</div>';

      stage.innerHTML =
        '<div class="stage-card"><div class="mines-stage">' +
          '<div class="mines-grid" id="mn-grid"></div>' +
          '<div class="up-roll" id="mn-roll">Choose bombs, bet, and start</div>' +
          '<div class="stage-hint">Cash out before you hit a bomb · every gem raises your multiplier</div>' +
        '</div></div>';

      // ---------------------------------------------------------- helpers

      function comb(n, k) {
        if (k < 0 || k > n) return 0;
        var r = 1;
        for (var i = 0; i < k; i++) r = r * (n - i) / (i + 1);
        return r;
      }
      // multiplier after n safe picks with b bombs, 1% house edge
      function mult(n, b) {
        if (n <= 0) return 1;
        var den = comb(25 - b, n);
        if (den <= 0) return 0;
        return comb(25, n) / den * 0.99;
      }
      function fmtMult(x) {
        if (x >= 1000) return UI.fmtShort(Math.round(x));
        return (Math.round(x * 100) / 100).toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
      }
      function parseBet(str) {
        str = String(str || '').toLowerCase().trim().replace(/[,\s_]/g, '');
        var m = str.match(/^([\d.]+)(k|m|b)?$/);
        if (!m) return NaN;
        var num = parseFloat(m[1]);
        if (!isFinite(num) || num <= 0) return NaN;
        return Math.floor(num * (m[2] === 'k' ? 1e3 : m[2] === 'm' ? 1e6 : m[2] === 'b' ? 1e9 : 1));
      }
      function balance() { return window.FF_balance(); }

      // ---------------------------------------------------------- state

      var picks = 0, bet = 0, mineSet = {}, active = false;
      var resolving = false;

      // ---------------------------------------------------------- UI refs

      var betInput = document.getElementById('mn-bet');
      var bombRange = document.getElementById('mn-bombs');
      var gridEl = document.getElementById('mn-grid');
      var multEl = document.getElementById('mn-mult');
      var nextEl = document.getElementById('mn-next');
      var rollEl = document.getElementById('mn-roll');
      var startBtn = document.getElementById('mn-start');
      var cashBtn = document.getElementById('mn-cashout');

      function bombsVal() {
        var v = parseInt(bombRange.value, 10);
        return isNaN(v) ? 3 : Math.max(1, Math.min(24, v));
      }

      function refreshStats() {
        multEl.textContent = fmtMult(mult(picks, bombsVal())) + '×';
        nextEl.textContent = fmtMult(mult(picks + 1, bombsVal())) + '×';
      }

      function buildGrid() {
        gridEl.innerHTML = '';
        for (var i = 0; i < 25; i++) {
          var tile = document.createElement('button');
          tile.className = 'mn-tile';
          tile.setAttribute('data-i', String(i));
          tile.addEventListener('click', (function (idx) {
            return function () { pick(idx); };
          })(i));
          gridEl.appendChild(tile);
        }
      }

      function lockTiles(lock) {
        Array.prototype.forEach.call(gridEl.children, function (t) { t.disabled = lock; });
      }

      // ---------------------------------------------------------- gameplay

      function start() {
        if (resolving) return;
        bet = parseBet(betInput.value);
        if (!UI.canBet(bet)) return;
        if (!UI.takeBet(bet)) return;
        active = true;
        picks = 0;
        var nonce = window.FF_nextNonce();
        var fair = window.FF_fair();
        var arr = window.FlameFair.minesLayout(fair.serverSeed, fair.clientSeed, nonce, bombsVal());
        mineSet = {};
        arr.forEach(function (p) { mineSet[p] = true; });

        gridEl.classList.add('live');
        buildGrid();
        lockTiles(false);
        startBtn.style.display = 'none';
        cashBtn.style.display = '';
        cashBtn.disabled = true;
        var b = bombsVal();
        rollEl.textContent = 'Pick a tile — ' + b + ' bomb' + (b > 1 ? 's' : '') + ' hidden on the field';
        rollEl.className = 'up-roll';
        UI.sClick();
        refreshStats();
      }

      function pick(i) {
        if (!active || resolving) return;
        var tile = gridEl.children[i];
        if (!tile || tile.classList.contains('gem') || tile.classList.contains('bomb')) return;
        resolving = true;
        tile.classList.add('open');
        setTimeout(function () {
          resolving = false;
          if (mineSet[i]) {
            tile.classList.remove('gem');
            tile.classList.add('bomb');
            revealAll();
            endRound(false);
          } else {
            tile.classList.add('gem');
            picks++;
            UI.sTick();
            refreshStats();
            cashBtn.disabled = false;
            if (picks >= 25 - bombsVal()) {
              revealAll();
              endRound(true, true);
            }
          }
        }, 130);
      }

      function revealAll() {
        Array.prototype.forEach.call(gridEl.children, function (t, i) {
          if (t.classList.contains('gem') || t.classList.contains('bomb')) { t.disabled = true; return; }
          t.classList.add('open');
          if (mineSet[i]) t.classList.add('bomb');
          else t.classList.add('gem', 'missed');
          t.disabled = true;
        });
      }

      function cashout() {
        if (!active || resolving || picks < 1) return;
        revealAll();
        endRound(true, false);
      }

      function endRound(win, cleared) {
        active = false;
        gridEl.classList.remove('live');
        lockTiles(true);
        startBtn.style.display = '';
        cashBtn.style.display = 'none';
        var m = mult(picks, bombsVal());
        if (win) {
          var payout = Math.floor(bet * m);
          UI.credit(payout);
          UI.recordBet('Mines', bet, m);
          UI.pushWin('Mines', payout - bet, m);
          UI.sWin();
          rollEl.textContent = cleared
            ? 'Board cleared! +' + UI.fmtShort(payout - bet) + ' coins!'
            : 'Cashed out at ' + fmtMult(m) + '× — +' + UI.fmtShort(payout - bet) + ' coins!';
          rollEl.className = 'up-roll w';
        } else {
          UI.recordBet('Mines', bet, 0);
          UI.sLose();
          rollEl.textContent = 'BOOM — you hit a bomb';
          rollEl.className = 'up-roll l';
        }
        renderHistory();
      }

      // ---------------------------------------------------------- history

      function renderHistory() {
        var el = document.getElementById('mn-history');
        var rows = window.FF_history().filter(function (h) { return h.game === 'Mines'; }).slice(0, 6);
        el.innerHTML = '<div class="bet-label">Recent mines rounds</div>' + (rows.length
          ? rows.map(function (h) {
              return '<div class="bh-row"><span>' + UI.fmtShort(h.bet) + ' → ' + fmtMult(h.mult || 1) + '×</span>' +
                '<span class="' + (h.mult >= 1 ? 'w' : 'l') + '">' + (h.mult >= 1 ? 'WIN' : 'LOSE') + '</span></div>';
            }).join('')
          : '<div class="bh-row"><span class="m">No rounds yet</span></div>');
      }

      // ---------------------------------------------------------- wiring

      document.getElementById('mn-half').addEventListener('click', function () {
        var v = parseBet(betInput.value) || Math.floor(balance() / 2);
        betInput.value = String(Math.max(1, Math.floor(v / 2)));
      });
      document.getElementById('mn-2x').addEventListener('click', function () {
        var v = parseBet(betInput.value) || Math.floor(balance() / 2);
        betInput.value = String(Math.max(1, v * 2));
      });
      document.getElementById('mn-max').addEventListener('click', function () {
        betInput.value = String(Math.floor(balance()));
      });
      startBtn.addEventListener('click', start);
      cashBtn.addEventListener('click', cashout);
      bombRange.addEventListener('input', refreshStats);

      buildGrid();
      lockTiles(true);
      refreshStats();
      renderHistory();
    }
  };
})();
