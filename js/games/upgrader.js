/*
 * FlameFlip — Upgrader.
 * Choose a bet and a target multiplier (1.01x–1000x). Win chance is
 * 0.96 / target (4% house edge). The gauge lights up a win arc equal to the
 * chance, then the needle spins and settles inside or outside the arc.
 *
 * Geometry: semicircle arc centred at (125,130), radius 105. Angle 0° points
 * straight up; the arc runs from -90° (left) to +90° (right). A roll f ∈ [0,1)
 * lands at angle (-90 + 180·f)°, and the win arc covers the first
 * (chance × 180)° of the semicircle from the left — so needle inside arc = win.
 */
(function () {
  'use strict';

  var MIN_T = 1.01, MAX_T = 1000;
  var CX = 125, CY = 130, R = 105;

  window.FFGames = window.FFGames || {};
  window.FFGames.upgrader = {
    id: 'upgrader',
    name: 'Upgrader',
    icon: 'i-gauge',
    desc: 'Pick your own multiplier',
    render: function (betSide, stage) {
      var UI = window.FFUI; // lazy: app.js loads last

      betSide.innerHTML =
        '<div class="bet-card">' +
          '<div class="bet-label">Bet amount</div>' +
          '<div class="bet-row"><div class="bet-input-wrap"><svg><use href="#i-coin"/></svg>' +
          '<input type="text" id="up-bet" inputmode="numeric" placeholder="0"></div>' +
          '<button class="btn-ghost sm" id="up-max">Max</button></div>' +
          '<div class="half-2x">' +
            '<button class="btn-ghost" id="up-half">½</button>' +
            '<button class="btn-ghost" id="up-2x">2×</button>' +
            '<button class="btn-ghost" id="up-min">Min</button>' +
          '</div>' +

          '<div class="side-label">Target multiplier — type it in, e.g. 2x, 4x, 6x</div>' +
          '<div class="target-row"><input type="text" id="up-target" class="tinput" inputmode="decimal" value="2" aria-label="Target multiplier"><span class="target-x">×</span></div>' +
          '<div class="up-chips" id="up-chips">' +
            '<button class="chip" data-t="1.5">1.5×</button>' +
            '<button class="chip" data-t="2">2×</button>' +
            '<button class="chip" data-t="5">5×</button>' +
            '<button class="chip" data-t="10">10×</button>' +
            '<button class="chip" data-t="100">100×</button>' +
          '</div>' +
          '<div class="range-row"><input type="range" id="up-range" min="101" max="100000" value="200">' +
          '<div class="range-nums"><span>1.01×</span><span>1000×</span></div></div>' +
          '<div class="up-stat"><span>Win chance</span><b id="up-chance">48.00%</b></div>' +
          '<div class="up-stat"><span>Payout on win</span><b id="up-payout">—</b></div>' +

          '<button class="btn-brand wide play-btn" id="up-play">Upgrade</button>' +
          '<div class="bet-history" id="up-history"></div>' +
        '</div>';

      stage.innerHTML =
        '<div class="stage-card"><div class="up-stage">' +
          '<div class="gauge"><svg viewBox="0 0 250 150">' +
            '<defs><linearGradient id="gaugeGrad" x1="0" y1="0" x2="1" y2="0">' +
              '<stop offset="0" stop-color="#ff4d00"/><stop offset="1" stop-color="#ffc247"/></linearGradient></defs>' +
            '<path class="gauge-arc-bg" d="M 20 130 A 105 105 0 0 1 230 130"/>' +
            '<path class="gauge-arc-win" id="up-arc" d="M 20 130 A 105 105 0 0 1 230 130"/>' +
            '<g class="gauge-needle" id="up-needle"><path d="M125 130 L123.5 42 L126.5 42 Z" fill="#eceded"/>' +
              '<circle cx="125" cy="130" r="9" fill="#2a2e32" stroke="#5d6669" stroke-width="2"/></g>' +
          '</svg></div>' +
          '<div class="up-roll" id="up-roll">Ready — set your target</div>' +
          '<div class="stage-hint">The needle must land inside the lit arc · chance = 96% ÷ multiplier</div>' +
        '</div></div>';

      var betInput = document.getElementById('up-bet');
      var range = document.getElementById('up-range');
      var targetInput = document.getElementById('up-target');
      var arc = document.getElementById('up-arc');
      var needle = document.getElementById('up-needle');
      var rollEl = document.getElementById('up-roll');

      var ARC_LEN = Math.PI * R; // half-circle length

      function target() {
        return Math.max(MIN_T, Math.min(MAX_T, parseInt(range.value, 10) / 100));
      }

      function setTarget(t) {
        t = Math.max(MIN_T, Math.min(MAX_T, t));
        range.value = String(Math.round(t * 100));
        refresh();
      }

      // accepts "2", "2x", "2.5x", "1,000x"…
      function parseTarget(str) {
        str = String(str || '').toLowerCase().trim().replace(/x\s*$/, '').replace(/[,\s_]/g, '');
        var v = parseFloat(str);
        if (!isFinite(v) || v <= 0) return NaN;
        return v;
      }

      function refresh() {
        var t = target();
        var chance = Math.min(1, 0.96 / t);
        // Win arc = first `chance` fraction of the semicircle, measured from the
        // left end. SVG dashoffset is measured from the path start (left end).
        arc.style.strokeDasharray = ARC_LEN + ' ' + ARC_LEN;
        arc.style.strokeDashoffset = String(ARC_LEN * (1 - chance));
        document.getElementById('up-chance').textContent = (chance * 100).toFixed(2) + '%';
        var bet = parseBet(betInput.value);
        document.getElementById('up-payout').textContent = isFinite(bet) && bet > 0
          ? UI.fmtShort(Math.floor(bet * t)) + ' coins'
          : '—';
      }

      // spin needle: from current rest angle, wind to start, then settle on the roll
      function spinNeedle(f, chance, done) {
        var finalAngle = -90 + 180 * f;          // -90 = far left, +90 = far right
        var lastAngle = parseFloat(needle.getAttribute('data-angle') || '-90');
        // wind back 2 full turns counter-clockwise from a point left of the target,
        // so the spin always sweeps clockwise past the arc before settling
        var windAngle = finalAngle - 720;
        needle.style.transition = 'none';
        needle.style.transform = 'rotate(' + windAngle + 'deg)';
        void needle.getBoundingClientRect(); // force reflow
        needle.style.transition = '';
        needle.style.transform = 'rotate(' + finalAngle + 'deg)';
        needle.setAttribute('data-angle', String(finalAngle));
        var gaugeEl = needle.closest('.gauge');
        if (gaugeEl) gaugeEl.classList.add('rolling');
        setTimeout(function () { if (gaugeEl) gaugeEl.classList.remove('rolling'); done(); }, 1250);
      }

      range.addEventListener('input', refresh);
      betInput.addEventListener('input', refresh);
      targetInput.addEventListener('input', function () {
        var v = parseTarget(targetInput.value);
        if (isFinite(v)) setTarget(v);
      });
      targetInput.addEventListener('blur', function () {
        targetInput.value = trim2(target());
      });
      targetInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') targetInput.blur();
      });

      document.getElementById('up-half').addEventListener('click', function () {
        var v = parseBet(betInput.value) || Math.floor(window.FF_balance() / 2);
        betInput.value = String(Math.max(1, Math.floor(v / 2)));
        refresh();
      });
      document.getElementById('up-2x').addEventListener('click', function () {
        var v = parseBet(betInput.value) || Math.floor(window.FF_balance() / 2);
        betInput.value = String(Math.max(1, v * 2));
        refresh();
      });
      document.getElementById('up-min').addEventListener('click', function () {
        betInput.value = '1'; refresh();
      });
      document.getElementById('up-max').addEventListener('click', function () {
        betInput.value = String(Math.floor(window.FF_balance())); refresh();
      });

      document.querySelectorAll('#up-chips .chip').forEach(function (c) {
        c.addEventListener('click', function () {
          setTarget(parseFloat(c.getAttribute('data-t')));
          targetInput.value = trim2(target());
        });
      });
      range.addEventListener('change', function () { targetInput.value = trim2(target()); });

      var busy = false;
      document.getElementById('up-play').addEventListener('click', function () {
        if (busy) return;
        var bet = parseBet(betInput.value);
        if (!UI.canBet(bet)) return;
        var t = target();
        var nonce = window.FF_nextNonce();
        var fair = window.FF_fair();
        var res = window.FlameFair.upgraderResult(fair.serverSeed, fair.clientSeed, nonce, t);
        if (!UI.takeBet(bet)) return;
        busy = true;

        rollEl.textContent = 'Rolling…';
        rollEl.className = 'up-roll';
        UI.sClick();

        spinNeedle(res.f, res.chance, function () {
          var win = res.win;
          var payout = Math.floor(bet * t);
          if (win) {
            UI.credit(payout);
            UI.recordBet('Upgrader', bet, t);
            UI.pushWin('Upgrader', payout - bet, t);
            UI.sWin();
            rollEl.textContent = 'WIN +' + UI.fmtShort(payout - bet) + ' coins!';
            rollEl.className = 'up-roll w';
          } else {
            UI.recordBet('Upgrader', bet, 0);
            UI.sLose();
            rollEl.textContent = 'BUST — rolled ' + (res.f * 100).toFixed(2) + '%, needed < ' + (res.chance * 100).toFixed(2) + '%';
            rollEl.className = 'up-roll l';
          }
          renderHistory();
          busy = false;
        });
      });

      refresh();
      renderHistory();

      function trim2(x) {
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
        var el = document.getElementById('up-history');
        var rows = window.FF_history().filter(function (h) { return h.game === 'Upgrader'; }).slice(0, 6);
        el.innerHTML = '<div class="bet-label">Recent upgrades</div>' + (rows.length
          ? rows.map(function (h) {
              return '<div class="bh-row"><span>' + UI.fmtShort(h.bet) + ' → ' + trim2(h.mult || 0) + '×</span>' +
                '<span class="' + (h.mult >= 1 ? 'w' : 'l') + '">' + (h.mult >= 1 ? 'WIN' : 'LOSE') + '</span></div>';
            }).join('')
          : '<div class="bh-row"><span class="m">No upgrades yet</span></div>');
      }
    }
  };
})();
