/*
 * FlameFlip — Coinflip.
 * Pick heads or tails, 1.98x payout. Result comes from the provably-fair core.
 */
(function () {
  'use strict';

  var sel = 'heads';
  var busy = false;

  window.FFGames = window.FFGames || {};
  window.FFGames.coinflip = {
    id: 'coinflip',
    name: 'Coinflip',
    icon: 'i-coin',
    desc: 'Heads or tails — 1.98x',
    render: function (betSide, stage) {
      var UI = window.FFUI;
      betSide.innerHTML =
        '<div class="bet-card">' +
          '<div class="bet-label">Bet amount</div>' +
          '<div class="bet-row"><div class="bet-input-wrap"><svg><use href="#i-coin"/></svg>' +
          '<input type="text" id="cf-bet" inputmode="numeric" placeholder="0"></div></div>' +
          '<div class="half-2x">' +
            '<button class="btn-ghost" id="cf-half">½</button>' +
            '<button class="btn-ghost" id="cf-2x">2×</button>' +
            '<button class="btn-ghost" id="cf-min">Min</button>' +
            '<button class="btn-ghost" id="cf-max">Max</button>' +
          '</div>' +
          '<div class="side-label">Pick a side</div>' +
          '<div class="side-btns">' +
            '<button class="side-btn sel" data-side="heads"><span class="coin h">H</span>Heads</button>' +
            '<button class="side-btn" data-side="tails"><span class="coin t">T</span>Tails</button>' +
          '</div>' +
          '<button class="btn-brand wide play-btn" id="cf-play">Flip coin</button>' +
          '<div class="bet-history" id="cf-history"></div>' +
        '</div>';

      stage.innerHTML =
        '<div class="stage-card"><div class="flip-stage">' +
          '<div class="flip-coin heads" id="cf-coin">H</div>' +
          '<div class="flip-result" id="cf-result">Pick heads or tails</div>' +
          '<div class="stage-hint">Win pays <b style="color:var(--brand-2)">1.98×</b> your bet · 1% edge</div>' +
        '</div></div>';

      var betInput = document.getElementById('cf-bet');

      document.getElementById('cf-half').addEventListener('click', function () {
        var v = parseBet(betInput.value) || betFromBalance();
        betInput.value = String(Math.max(1, Math.floor(v / 2)));
      });
      document.getElementById('cf-2x').addEventListener('click', function () {
        var v = parseBet(betInput.value) || betFromBalance();
        betInput.value = String(Math.max(1, v * 2));
      });
      document.getElementById('cf-min').addEventListener('click', function () { betInput.value = '1'; });
      document.getElementById('cf-max').addEventListener('click', function () { betInput.value = String(Math.floor(balance())); });

      var sideBtns = betSide.querySelectorAll('.side-btn');
      sideBtns.forEach(function (b) {
        b.addEventListener('click', function () {
          if (busy) return;
          sideBtns.forEach(function (x) { x.classList.remove('sel'); });
          b.classList.add('sel');
          sel = b.getAttribute('data-side');
          UI.sClick();
        });
      });

      document.getElementById('cf-play').addEventListener('click', play);

      renderHistory();
      document.addEventListener('ff-balance', syncMaxBtn);

      // ------------------------------------------------------------------

      function balance() { return window.FF_balance(); }
      function betFromBalance() { return Math.floor(balance() / 2); }

      function parseBet(str) {
        str = String(str || '').toLowerCase().trim().replace(/[,\s_]/g, '');
        var m = str.match(/^([\d.]+)(k|m|b)?$/);
        if (!m) return NaN;
        var num = parseFloat(m[1]);
        if (!isFinite(num) || num <= 0) return NaN;
        return Math.floor(num * (m[2] === 'k' ? 1e3 : m[2] === 'm' ? 1e6 : m[2] === 'b' ? 1e9 : 1));
      }

      function syncMaxBtn() { /* placeholder for live updates */ }

      function renderHistory() {
        var el = document.getElementById('cf-history');
        var rows = window.FF_history().filter(function (h) { return h.game === 'Coinflip'; }).slice(0, 6);
        el.innerHTML = '<div class="bet-label">Recent flips</div>' + (rows.length
          ? rows.map(function (h) {
              return '<div class="bh-row"><span>' + UI.fmtShort(h.bet) + ' bet</span>' +
                '<span class="' + (h.mult >= 1 ? 'w' : 'l') + '">' + (h.mult >= 1 ? '+' + UI.fmtShort(h.bet * (h.mult - 1)) : '-' + UI.fmtShort(h.bet)) + '</span></div>';
            }).join('')
          : '<div class="bh-row"><span class="m">No flips yet</span></div>');
      }

      function play() {
        if (busy) return;
        var bet = parseBet(betInput.value);
        if (!UI.canBet(bet)) return;
        busy = true;
        var nonce = window.FF_nextNonce();
        var fair = window.FF_fair();
        var res = window.FlameFair.coinflipResult(fair.serverSeed, fair.clientSeed, nonce);

        var bet2 = bet;
        if (!window.FFUI.takeBet(bet2)) { busy = false; return; }

        var coin = document.getElementById('cf-coin');
        var resultEl = document.getElementById('cf-result');
        coin.classList.add('flipping');
        coin.textContent = '?';
        resultEl.textContent = 'Flipping…';
        resultEl.className = 'flip-result';
        UI.sClick();

        setTimeout(function () {
          coin.classList.remove('flipping');
          var won = res.side === sel;
          coin.className = 'flip-coin ' + res.side;
          coin.textContent = res.side === 'heads' ? 'H' : 'T';
          var payout = Math.floor(bet2 * 1.98);
          if (won) {
            UI.credit(payout);
            UI.recordBet('Coinflip', bet2, 1.98);
            UI.pushWin('Coinflip', payout - bet2, 1.98);
            UI.sWin();
            resultEl.textContent = res.side.toUpperCase() + ' — you win ' + UI.fmtShort(payout - bet2) + '!';
            resultEl.className = 'flip-result w';
          } else {
            UI.recordBet('Coinflip', bet2, 0);
            UI.sLose();
            resultEl.textContent = res.side.toUpperCase() + ' — you lose ' + UI.fmtShort(bet2);
            resultEl.className = 'flip-result l';
          }
          renderHistory();
          busy = false;
        }, 1400);
      }
    }
  };
})();
