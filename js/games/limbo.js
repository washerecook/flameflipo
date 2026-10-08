/*
 * FlameFlip — Limbo.
 * Pick a target multiplier (1.01x–1,000,000x). The roll is 0.96 / float
 * (4% house edge); you win when the rolled multiplier reaches your target.
 */
(function () {
  'use strict';

  var MIN_T = 1.01, MAX_T = 1000000;
  var busy = false;

  window.FFGames = window.FFGames || {};
  window.FFGames.limbo = {
    id: 'limbo',
    name: 'Limbo',
    icon: 'i-bolt',
    desc: 'How low will the roll go?',
    render: function (betSide, stage) {
      var UI = window.FFUI; // lazy: app.js loads last
      betSide.innerHTML =
        '<div class="bet-card">' +
          '<div class="bet-label">Bet amount</div>' +
          '<div class="bet-row"><div class="bet-input-wrap"><svg><use href="#i-coin"/></svg>' +
          '<input type="text" id="lb-bet" inputmode="numeric" placeholder="0"></div>' +
          '<button class="btn-ghost sm" id="lb-max">Max</button></div>' +
          '<div class="half-2x">' +
            '<button class="btn-ghost" id="lb-half">½</button>' +
            '<button class="btn-ghost" id="lb-2x">2×</button>' +
            '<button class="btn-ghost" id="lb-min">Min</button>' +
          '</div>' +

          '<div class="side-label">Target multiplier — type it in, e.g. 2x, 4x, 6x</div>' +
          '<div class="target-row"><input type="text" id="lb-target" class="tinput" inputmode="decimal" value="2" aria-label="Target multiplier"><span class="target-x">×</span></div>' +
          '<div class="range-row"><input type="range" id="lb-range" min="101" max="100000000" value="200">' +
          '<div class="range-nums"><span>1.01×</span><span>1,000,000×</span></div></div>' +
          '<div class="up-stat"><span>Win chance</span><b id="lb-chance">48.00%</b></div>' +
          '<div class="up-stat"><span>Payout on win</span><b id="lb-payout">—</b></div>' +

          '<button class="btn-brand wide play-btn" id="lb-play">Roll</button>' +
          '<div class="bet-history" id="lb-history"></div>' +
        '</div>';

      stage.innerHTML =
        '<div class="stage-card"><div class="limbo-stage">' +
          '<div class="limbo-big" id="lb-rolled">—</div>' +
          '<div class="up-roll" id="lb-roll">Set a target and roll</div>' +
          '<div class="stage-hint">Roll = 96% ÷ float · you win if the roll reaches <b style="color:var(--brand-2)">your target</b> · 4% edge</div>' +
        '</div></div>';

      var betInput = document.getElementById('lb-bet');
      var range = document.getElementById('lb-range');
      var targetInput = document.getElementById('lb-target');
      var rolledEl = document.getElementById('lb-rolled');

      function target() { return Math.max(MIN_T, Math.min(MAX_T, parseInt(range.value, 10) / 100)); }
      function setTarget(t) {
        t = Math.max(MIN_T, Math.min(MAX_T, t));
        range.value = String(Math.round(t * 100));
        refresh();
      }

      function refresh() {
        var t = target();
        var chance = 0.96 / t;
        document.getElementById('lb-chance').textContent = chance >= 1 ? '100%' : (chance * 100).toFixed(2) + '%';
        var bet = parseBet(betInput.value);
        document.getElementById('lb-payout').textContent = isFinite(bet) && bet > 0
          ? UI.fmtShort(Math.floor(bet * t)) + ' coins'
          : '—';
 }

      // accepts "2", "2x", "2.5x", "1000x"…
      function parseTarget(str) {
        str = String(str || '').toLowerCase().trim().replace(/x\s*$/, '').replace(/[,\s_]/g, '');
        var v = parseFloat(str);
        if (!isFinite(v) || v <= 0) return NaN;
        return v;
      }

      range.addEventListener('input', refresh);
      betInput.addEventListener('input', refresh);
      targetInput.addEventListener('input', function () {
        var v = parseTarget(targetInput.value);
        if (isFinite(v)) setTarget(v);
      });
      targetInput.addEventListener('blur', function () {
        targetInput.value = fmtMult(target());
      });
      targetInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') targetInput.blur();
      });
      range.addEventListener('change', function () { targetInput.value = fmtMult(target()); });

      document.getElementById('lb-half').addEventListener('click', function () {
        var v = parseBet(betInput.value) || Math.floor(window.FF_balance() / 2);
        betInput.value = String(Math.max(1, Math.floor(v / 2)));
      });
      document.getElementById('lb-2x').addEventListener('click', function () {
        var v = parseBet(betInput.value) || Math.floor(window.FF_balance() / 2);
        betInput.value = String(Math.max(1, v * 2));
      });
      document.getElementById('lb-min').addEventListener('click', function () { betInput.value = '1'; });
      document.getElementById('lb-max').addEventListener('click', function () {
        betInput.value = String(Math.floor(window.FF_balance()));
      });

      renderHistory();

      document.getElementById('lb-play').addEventListener('click', function () {
        if (busy) return;
        var bet = parseBet(betInput.value);
        if (!UI.canBet(bet)) return;
        var t = target();
        var nonce = window.FF_nextNonce();
        var fair = window.FF_fair();
        var res = window.FlameFair.limboResult(fair.serverSeed, fair.clientSeed, nonce);
        if (!UI.takeBet(bet)) return;
        busy = true;
        UI.sClick();

        var win = res.rolled >= t;
        rolledEl.className = 'limbo-big';
        rolledEl.textContent = '…';

        // count-up roller for suspense
        var startTime = Date.now();
        var DUR = 900;
        (function tickRoll() {
          var p = Math.min(1, (Date.now() - startTime) / DUR);
          var shown = res.rolled * (0.85 * p);
          rolledEl.textContent = fmtMult(Math.max(1.01, shown)) + '×';
          if (p < 1) { rolledEl.classList.add('rolling'); setTimeout(tickRoll, 40); return; }
          finish();
        })();

        function finish() {
          rolledEl.textContent = fmtMult(res.rolled) + '×';
          rolledEl.classList.remove('rolling');
          var payout = Math.floor(bet * t);
          if (win) {
            UI.credit(payout);
            UI.recordBet('Limbo', bet, t);
            UI.pushWin('Limbo', payout - bet, t);
            UI.sWin();
            rolledEl.className = 'limbo-big w';
            document.getElementById('lb-roll').textContent = 'WIN +' + UI.fmtShort(payout - bet) + ' coins!';
            document.getElementById('lb-roll').className = 'up-roll w';
          } else {
            UI.recordBet('Limbo', bet, 0);
            UI.sLose();
            rolledEl.className = 'limbo-big l';
            document.getElementById('lb-roll').textContent = 'Rolled ' + fmtMult(res.rolled) + '× — needed ' + fmtMult(t) + '×';
            document.getElementById('lb-roll').className = 'up-roll l';
          }
          renderHistory();
          busy = false;
        }
      });

      refresh();

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
      function renderHistory() {
        var el = document.getElementById('lb-history');
        var rows = window.FF_history().filter(function (h) { return h.game === 'Limbo'; }).slice(0, 6);
        el.innerHTML = '<div class="bet-label">Recent rolls</div>' + (rows.length
          ? rows.map(function (h) {
              return '<div class="bh-row"><span>' + UI.fmtShort(h.bet) + ' → ' + (h.mult || 0) + '×</span>' +
                '<span class="' + (h.mult >= 1 ? 'w' : 'l') + '">' + (h.mult >= 1 ? 'WIN' : 'LOSE') + '</span></div>';
            }).join('')
          : '<div class="bh-row"><span class="m">No rolls yet</span></div>');
      }
    }
  };
})();
