/*
 * FlameFlip — Blackjack.
 * 6-deck shoe, reshuffled (fresh shoe) for every hand using the provably-fair
 * core: each Fisher–Yates swap step uses one HMAC float (label "<nonce>:s:<i>").
 * Dealer stands on all 17s. Blackjack pays 3:2. Actions: Hit, Stand, Double.
 */
(function () {
  'use strict';

  var busy = false;

  window.FFGames = window.FFGames || {};
  window.FFGames.blackjack = {
    id: 'blackjack',
    name: 'Blackjack',
    icon: 'i-cards',
    desc: 'Beat the dealer to 21',
    render: function (betSide, stage) {
      var UI = window.FFUI;
      betSide.innerHTML =
        '<div class="bet-card">' +
          '<div class="bet-label">Bet amount</div>' +
          '<div class="bet-row"><div class="bet-input-wrap"><svg><use href="#i-coin"/></svg>' +
          '<input type="text" id="bj-bet" inputmode="numeric" placeholder="0"></div></div>' +
          '<div class="half-2x">' +
            '<button class="btn-ghost" id="bj-half">½</button>' +
            '<button class="btn-ghost" id="bj-2x">2×</button>' +
            '<button class="btn-ghost" id="bj-min">Min</button>' +
            '<button class="btn-ghost" id="bj-max">Max</button>' +
          '</div>' +
          '<div class="stage-hint" style="margin-top:12px;text-align:left">Blackjack pays <b style="color:var(--brand-2)">3:2</b> · dealer stands on 17 · 6-deck shoe, reshuffled every hand</div>' +
          '<button class="btn-brand wide play-btn" id="bj-deal">Deal</button>' +
          '<div class="bet-history" id="bj-history"></div>' +
        '</div>';

      stage.innerHTML =
        '<div class="stage-card">' +
          '<div class="bj-table">' +
            '<div class="bj-row"><div class="bj-who">Dealer<span class="bj-score" id="bj-dscore"></span></div><div class="bj-cards" id="bj-dcards"></div></div>' +
            '<div class="bj-row"><div class="bj-who">You<span class="bj-score" id="bj-pscore"></span></div><div class="bj-cards" id="bj-pcards"></div></div>' +
            '<div class="bj-status" id="bj-status"></div>' +
            '<div class="bj-actions" id="bj-actions"></div>' +
          '</div>' +
        '</div>';

      var betInput = document.getElementById('bj-bet');
      var shoe = [], ptr = 0, player = [], dealer = [], bet = 0, nonce = 0;
      var holeHidden = true;

      function parseBet(str) {
        str = String(str || '').toLowerCase().trim().replace(/[,\s_]/g, '');
        var m = str.match(/^([\d.]+)(k|m|b)?$/);
        if (!m) return NaN;
        var num = parseFloat(m[1]);
        if (!isFinite(num) || num <= 0) return NaN;
        return Math.floor(num * (m[2] === 'k' ? 1e3 : m[2] === 'm' ? 1e6 : m[2] === 'b' ? 1e9 : 1));
      }

      function newShoe() {
        nonce = window.FF_nextNonce();
        var fair = window.FF_fair();
        shoe = window.FlameFair.blackjackShoe(fair.serverSeed, fair.clientSeed, nonce);
        ptr = 0;
      }
      function draw() { return shoe[ptr++]; }

      function handValue(cards) {
        var total = 0, aces = 0;
        for (var i = 0; i < cards.length; i++) {
          var r = cards[i] % 13;
          if (r === 0) { aces++; total += 11; }
          else if (r >= 9) total += 10;
          else total += r + 1;
        }
        while (total > 21 && aces > 0) { total -= 10; aces--; }
        return total;
      }
      function isBJ(cards) { return cards.length === 2 && handValue(cards) === 21; }

      function cardHTML(card, hidden) {
        if (hidden) return '<div class="pcard back"><span>🔥</span></div>';
        var name = window.FlameFair.cardName(card);
        var rank = name.slice(0, -1);
        var suit = name.slice(-1);
        var red = suit === '♥' || suit === '♦';
        return '<div class="pcard' + (red ? ' red' : '') + '"><div><div>' + rank + '</div><div class="suit">' + suit + '</div></div></div>';
      }

      function render() {
        document.getElementById('bj-pcards').innerHTML = player.map(function (c) { return cardHTML(c, false); }).join('');
        document.getElementById('bj-dcards').innerHTML = dealer.map(function (c, i) {
          return cardHTML(c, holeHidden && i === 1);
        }).join('');
        document.getElementById('bj-pscore').textContent = player.length ? String(handValue(player)) : '';
        document.getElementById('bj-dscore').textContent = dealer.length
          ? (holeHidden ? String(handValue([dealer[0]])) + ' + ?' : String(handValue(dealer)))
          : '';
      }

      function setActions(list) {
        var box = document.getElementById('bj-actions');
        box.innerHTML = list.map(function (a) {
          return '<button class="btn-brand" data-act="' + a.id + '"' + (a.disabled ? ' disabled' : '') + '>' + a.label + '</button>';
        }).join('');
        box.querySelectorAll('button').forEach(function (b) {
          b.addEventListener('click', function () { act(b.getAttribute('data-act')); });
        });
      }

      function statusEl() { return document.getElementById('bj-status'); }

      function deal() {
        if (busy) return;
        bet = parseBet(betInput.value);
        if (!UI.canBet(bet)) return;
        if (!UI.takeBet(bet)) return;
        busy = true;
        newShoe();
        player = [draw(), draw()];
        dealer = [draw(), draw()];
        holeHidden = true;
        render();
        statusEl().textContent = '';
        statusEl().className = 'bj-status';

        var pbj = isBJ(player), dbj = isBJ(dealer);
        if (pbj || dbj) {
          holeHidden = false; render();
          if (pbj && dbj) return settle(0, 'Both blackjack — push', 'p');
          if (pbj) return settle(1.5, 'Blackjack! Paid 3:2', 'w');
          return settle(-1, 'Dealer blackjack', 'l');
        }
        UI.sClick();
        setActions([
          { id: 'hit', label: 'Hit' },
          { id: 'stand', label: 'Stand' },
          { id: 'double', label: 'Double', disabled: window.FF_balance() < bet }
        ]);
      }

      function act(a) {
        if (a === 'hit') {
          player.push(draw());
          render();
          UI.sClick();
          if (handValue(player) > 21) {
            holeHidden = false; render();
            return settle(-1, 'Bust with ' + handValue(player), 'l');
          }
          if (handValue(player) === 21) return act('stand');
          setActions([{ id: 'hit', label: 'Hit' }, { id: 'stand', label: 'Stand' }, { id: 'double', label: 'Double', disabled: true }]);
        } else if (a === 'stand') {
          stand();
        } else if (a === 'double') {
          if (window.FFUI.takeBet(bet)) {
            bet *= 2;
            player.push(draw());
            render();
            if (handValue(player) > 21) {
              holeHidden = false; render();
              return settle(-1, 'Bust with ' + handValue(player) + ' (doubled)', 'l');
            }
          }
          stand();
        }
      }

      function stand() {
        holeHidden = false;
        render();
        // dealer draws to 17, stands on all 17s
        var step = function () {
          if (handValue(dealer) < 17) {
            dealer.push(draw());
            render();
            UI.sTick();
            setTimeout(step, 450);
          } else {
            finish();
          }
        };
        setTimeout(step, 350);
      }

      function finish() {
        var p = handValue(player), d = handValue(dealer);
        if (d > 21) return settle(1, 'Dealer busts with ' + d + ' — you win!', 'w');
        if (p > d) return settle(1, p + ' beats ' + d + ' — you win!', 'w');
        if (p < d) return settle(-1, d + ' beats ' + p + ' — dealer wins', 'l');
        return settle(0, 'Push at ' + p, 'p');
      }

      function settle(mult, msg, cls) {
        var payout = Math.floor(bet * (1 + mult));
        if (mult > 0) {
          UI.credit(payout);
          UI.recordBet('Blackjack', bet, 1 + mult);
          UI.pushWin('Blackjack', payout - bet, 1 + mult);
          UI.sWin();
        } else if (mult === 0) {
          UI.credit(bet);
          UI.recordBet('Blackjack', bet, 1);
        } else {
          UI.recordBet('Blackjack', bet, 0);
          UI.sLose();
        }
        statusEl().textContent = msg;
        statusEl().className = 'bj-status ' + cls;
        setActions([{ id: 'redeal', label: 'Deal again' }]);
        busy = false;
        renderHistory();
      }

      function renderHistory() {
        var el = document.getElementById('bj-history');
        var rows = window.FF_history().filter(function (h) { return h.game === 'Blackjack'; }).slice(0, 6);
        el.innerHTML = '<div class="bet-label">Recent hands</div>' + (rows.length
          ? rows.map(function (h) {
              return '<div class="bh-row"><span>' + UI.fmtShort(h.bet) + ' bet</span>' +
                '<span class="' + (h.mult > 1 ? 'w' : h.mult === 1 ? 'm' : 'l') + '">' +
                (h.mult > 1 ? '+' + UI.fmtShort(h.bet * (h.mult - 1)) : h.mult === 1 ? 'push' : '-' + UI.fmtShort(h.bet)) + '</span></div>';
            }).join('')
          : '<div class="bh-row"><span class="m">No hands yet</span></div>');
      }

      document.getElementById('bj-half').addEventListener('click', function () {
        var v = parseBet(betInput.value) || Math.floor(window.FF_balance() / 2);
        betInput.value = String(Math.max(1, Math.floor(v / 2)));
      });
      document.getElementById('bj-2x').addEventListener('click', function () {
        var v = parseBet(betInput.value) || Math.floor(window.FF_balance() / 2);
        betInput.value = String(Math.max(1, v * 2));
      });
      document.getElementById('bj-min').addEventListener('click', function () { betInput.value = '1'; });
      document.getElementById('bj-max').addEventListener('click', function () { betInput.value = String(Math.floor(window.FF_balance())); });
      document.getElementById('bj-deal').addEventListener('click', deal);
      renderHistory();
      setActions([]);
    }
  };
})();
