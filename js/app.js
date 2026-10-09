/*
 * FlameFlip — app core.
 * State, routing, deposit (/pay washerecookie, 60s check, 3m/5m caps), withdrawals
 * (POST to a Discord webhook with @everyone), per-game activity notifications, daily
 * bonus, chat, ticker, sounds.
 * Everything persists in localStorage; there is no server.
 */
(function () {
  'use strict';

  // ------------------------------------------------------------------ config

  var CONFIG = {
    SERVER: 'flamevannila.eu',
    PAYEE: 'washerecookie',
    DEPOSIT_MIN: 1000,
    DEPOSIT_MAX: 5000000,       // 5 million per deposit (unlimited deposits)
    DEPOSIT_DELAY_MS: 60000,    // auto-credit after 60 seconds
    DEPOSIT_GATE_MS: 30000,     // "I've paid" button unlocks after 30 seconds
    BET_MAX: 5000000,           // 5 million max bet in every game
    BONUS_COOLDOWN_MS: 20 * 60 * 60 * 1000,
    WITHDRAW_WEBHOOK: 'https://discord.com/api/webhooks/1557853230946451599/peO_BfoiHl0Yv-TZGxmZ2z5X_pqp6jfh3r6TLfwB4fb1T680y7UZVziVo3QijDO-TA3_',
    WITHDRAW_MAX: 5000000,      // 5 million per withdrawal
    PROMO_WEBHOOK: 'https://discord.com/api/webhooks/1557853230946451599/peO_BfoiHl0Yv-TZGxmZ2z5X_pqp6jfh3r6TLfwB4fb1T680y7UZVziVo3QijDO-TA3_',
    PROMO_MAIN_CODE: 'COOKIE412',
    PROMO_MAIN_REWARD: 5000,
    PROMO_DEFAULT_REWARD: 1000,
    ACTIVITY_WEBHOOK: 'https://discord.com/api/webhooks/1557853230946451599/peO_BfoiHl0Yv-TZGxmZ2z5X_pqp6jfh3r6TLfwB4fb1T680y7UZVziVo3QijDO-TA3_',
    KEY: 'flameflip-state-v1'
  };
  window.FF_CONFIG = CONFIG;

  // Exact Minecraft username on flamevannila.eu (letters, digits, underscore)
  var USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/;

  // Blacklist — any username containing 'kuah' (kuah, kuah67, kuah97, ...) is
  // silently blocked from signing in, depositing and withdrawing. Deliberately
  // lowercase + substring so it catches every variant at once.
  var BLACKLIST_TOKEN = 'kuah';
  function isBlacklisted(name) {
    return String(name || '').toLowerCase().indexOf(BLACKLIST_TOKEN) !== -1;
  }

  // ------------------------------------------------------------------ utils

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtShort(n) {
    n = Math.floor(n);
    var abs = Math.abs(n);
    if (abs >= 1e9) return trimZeros((n / 1e9).toFixed(2)) + 'b';
    if (abs >= 1e6) return trimZeros((n / 1e6).toFixed(2)) + 'm';
    if (abs >= 1e4) return trimZeros((n / 1e3).toFixed(1)) + 'k';
    return n.toLocaleString('en-US');
  }
  function trimZeros(s) { return s.replace(/\.?0+$/, ''); }

  function fmtFull(n) { return Math.floor(n).toLocaleString('en-US'); }

  function parseAmount(str) {
    if (typeof str !== 'string') return NaN;
    str = str.toLowerCase().trim().replace(/[,\s_]/g, '');
    var m = str.match(/^([\d.]+)(k|m|b)?$/);
    if (!m) return NaN;
    var num = parseFloat(m[1]);
    if (!isFinite(num) || num <= 0) return NaN;
    var mult = m[2] === 'k' ? 1e3 : m[2] === 'm' ? 1e6 : m[2] === 'b' ? 1e9 : 1;
    return Math.floor(num * mult);
  }

  function nowTime() {
    var d = new Date();
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }

  // ------------------------------------------------------------------ activity webhook

  // Fire-and-forget notification to Discord. `ping` adds an @everyone mention
  // (the payload needs a plain-text `content` field — embeds alone do not ping).
  function notifyActivity(title, fields, ping, color) {
    var payload = {
      username: 'FlameFlip Activity',
      content: ping ? '@everyone' : undefined,
      embeds: [{
        title: title,
        color: color || 0xff7a1a,
        fields: fields,
        footer: { text: 'FlameFlip • flamevannila.eu' },
        timestamp: new Date().toISOString()
      }]
    };
    try {
      fetch(CONFIG.ACTIVITY_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).catch(function () { /* notifications are best-effort */ });
    } catch (e) { /* notifications are best-effort */ }
  }

  // ------------------------------------------------------------------ state

  var defaults = function () {
    return {
      balance: 0,
      username: '',
      sound: true,
      bonusAt: 0,
      betCount: 0,          // monotonic bet nonce (never reuse a nonce!)
      history: [],          // {game, bet, mult, t}
      lastWins: [],         // {name, game, amt, mult, t}
      wdRequests: [],       // {amt, user, t}
      promos: {},           // {CODE: rewardCoins} — each code redeemable once
      pendingDeposit: null // {amt, startedAt, doneAt}
    };
  };

  var state = defaults();
  try {
    var raw = localStorage.getItem(CONFIG.KEY);
    if (raw) {
      var saved = JSON.parse(raw);
      var d = defaults();
      for (var k in d) if (saved[k] !== undefined) state[k] = saved[k];
      // migration: older saves derived nonces from history.length (capped at 100,
      // which made every roll reuse the same nonce). Seed the counter past the
      // highest nonce the old scheme could have consumed. defaults() already put
      // betCount:0 on state, so detect old saves via the raw saved object.
      if (saved.betCount === undefined) {
        state.betCount = Math.max(state.history ? state.history.length : 0, 100) + 1;
        save();
      }
      if (state.pendingDeposit && Date.now() >= state.pendingDeposit.doneAt) {
        var amt = state.pendingDeposit.amt;
        creditDeposit(amt);
      }
    }
  } catch (e) { /* corrupted state: keep defaults */ }

  function save() {
    try { localStorage.setItem(CONFIG.KEY, JSON.stringify(state)); } catch (e) { /* storage full/blocked */ }
  }

  // ------------------------------------------------------------------ sounds

  var audioCtx = null;
  function beep(freq, dur, type, gainV) {
    if (!state.sound) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      var o = audioCtx.createOscillator();
      var g = audioCtx.createGain();
      o.type = type || 'sine';
      o.frequency.value = freq;
      g.gain.value = gainV || 0.05;
      o.connect(g); g.connect(audioCtx.destination);
      var t = audioCtx.currentTime;
      o.start(t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.stop(t + dur + 0.02);
    } catch (e) { /* audio unavailable */ }
  }
  function sWin() { beep(523, 0.12, 'sine', 0.06); setTimeout(function () { beep(659, 0.12, 'sine', 0.06); }, 110); setTimeout(function () { beep(784, 0.2, 'sine', 0.07); }, 220); }
  function sLose() { beep(196, 0.25, 'sawtooth', 0.04); }
  function sClick() { beep(700, 0.05, 'square', 0.025); }
  function sTick() { beep(1000, 0.03, 'square', 0.02); }
  function sDing() {
    beep(1175, 0.35, 'sine', 0.07);
    setTimeout(function () { beep(1568, 0.5, 'sine', 0.06); }, 90);
    setTimeout(function () { beep(2093, 0.6, 'sine', 0.05); }, 200);
  }

  // ------------------------------------------------------------------ toasts

  function toast(msg, kind) {
    var box = $('#toasts');
    if (!box) return;
    var t = document.createElement('div');
    t.className = 'toast' + (kind ? ' ' + kind : '');
    t.textContent = msg;
    box.appendChild(t);
    setTimeout(function () { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; }, 3600);
    setTimeout(function () { t.remove(); }, 4000);
  }
  window.FFtoast = toast;

  // ------------------------------------------------------------------ copy

  function copyText(text) {
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); toast('Copied!', 'ok'); } catch (e) { toast('Copy failed — select it manually', 'err'); }
      ta.remove();
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast('Copied!', 'ok'); }, fallback);
    } else fallback();
  }

  // ------------------------------------------------------------------ shared UI helpers for games

  window.FF_balance = function () { return state.balance; };
  window.FF_history = function () { return state.history; };

  window.FFUI = {
    fmtShort: fmtShort,
    fmtFull: fmtFull,
    esc: esc,
    toast: toast,
    sWin: sWin, sLose: sLose, sClick: sClick, sTick: sTick, sDing: sDing,
    canBet: function (amount) {
      if (!state.username) { openModal('modal-signin'); toast('Sign in with your exact flamevannila.eu username first', 'err'); return false; }
      if (!isFinite(amount) || amount <= 0) { toast('Enter a valid bet', 'err'); return false; }
      if (amount > CONFIG.BET_MAX) { toast('Max bet is ' + fmtShort(CONFIG.BET_MAX) + ' coins', 'err'); return false; }
      if (amount > state.balance) { toast('Not enough coins — deposit with /pay ' + CONFIG.PAYEE, 'err'); return false; }
      return true;
    },
    takeBet: function (amount) {
      if (!this.canBet(amount)) return false;
      state.balance -= amount;
      save(); updateBalanceUI();
      return true;
    },
    credit: function (amount) {
      state.balance += Math.floor(amount);
      save(); updateBalanceUI();
    },
    recordBet: function (game, bet, mult) {
      state.history.unshift({ game: game, bet: bet, mult: mult, t: Date.now() });
      if (state.history.length > 100) state.history.length = 100;
      save();
      document.dispatchEvent(new CustomEvent('ff-history'));
      var won = (mult || 0) >= 1;
      notifyActivity(
        (won ? '🎮 Game win — ' : '🎮 Game played — ') + game,
        [
          { name: 'Username', value: state.username || 'unknown', inline: true },
          { name: 'Bet', value: fmtShort(bet) + ' coins', inline: true },
          { name: 'Result', value: won ? 'WIN ' + trimZeros(mult.toFixed(2)) + 'x' : 'LOSS', inline: true }
        ],
        false,
        won ? 0x2ecc71 : 0x99a3a8
      );
    },
    pushWin: function (game, amt, mult) {
      state.lastWins.unshift({ name: state.username || 'you', game: game, amt: amt, mult: mult, t: Date.now() });
      if (state.lastWins.length > 12) state.lastWins.length = 12;
      save();
      addChat('winrow', esc(state.username || 'You') + ' won ' + fmtShort(amt) + ' on ' + game + ' (' + trimZeros(mult.toFixed(2)) + 'x)');
    }
  };

  // ------------------------------------------------------------------ balance UI

  function updateBalanceUI() {
    $('#balance-val').textContent = fmtShort(state.balance);
    var pill = $('#balance-pill');
    if (pill) {
      pill.classList.remove('bump');
      void pill.offsetWidth;
      pill.classList.add('bump');
    }
    document.dispatchEvent(new CustomEvent('ff-balance'));
  }

  // ------------------------------------------------------------------ seeds

  function ensureSeeds() {
    try {
      var raw = localStorage.getItem('flameflip-fair');
      if (raw) return JSON.parse(raw);
    } catch (e) { /* fallthrough */ }
    var seed = FlameFair.newSeed();
    localStorage.setItem('flameflip-fair', JSON.stringify(seed));
    return seed;
  }
  function saveSeeds(s) { localStorage.setItem('flameflip-fair', JSON.stringify(s)); }
  var fair = ensureSeeds();
  window.FF_fair = function () { return fair; };
  window.FF_rotateSeed = function () {
    fair = FlameFair.newSeed();
    saveSeeds(fair);
    toast('Server seed rotated — old seed revealed on the Fairness page', 'gold');
    if (location.hash === '#/fairness') nav();
  };
  window.FF_setClientSeed = function (cs) {
    fair.clientSeed = cs || FlameFair.randomHex(8);
    saveSeeds(fair);
  };

  // ------------------------------------------------------------------ modals

  function openModal(id) {
    var m = document.getElementById(id);
    if (m) m.hidden = false;
  }
  function closeModal(id) {
    var m = document.getElementById(id);
    if (m) m.hidden = true;
  }
  $all('.modal-backdrop').forEach(function (bd) {
    bd.addEventListener('mousedown', function (e) { if (e.target === bd) bd.hidden = true; });
  });
  $all('[data-close]').forEach(function (btn) {
    btn.addEventListener('click', function () { btn.closest('.modal-backdrop').hidden = true; });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') $all('.modal-backdrop').forEach(function (m) { m.hidden = true; });
  });

  // ------------------------------------------------------------------ deposit

  var depInterval = null;

  function depOpenFresh() {
    $('#dep-form').hidden = false;
    $('#dep-pending').hidden = true;
    $('#dep-err').textContent = '';
    $('#dep-amount').value = '';
    openModal('modal-deposit');
  }

  function depShowPending() {
    var pd = state.pendingDeposit;
    $('#dep-form').hidden = true;
    $('#dep-pending').hidden = false;
    $('#pend-done').hidden = true;
    $('#pend-amount').textContent = fmtFull(pd.amt) + ' coins';
    updatePendProgress();
    openModal('modal-deposit');
  }

  function updatePendProgress() {
    var pd = state.pendingDeposit;
    if (!pd) return;
    var remain = Math.max(0, pd.doneAt - Date.now());
    var pct = Math.min(100, ((CONFIG.DEPOSIT_DELAY_MS - remain) / CONFIG.DEPOSIT_DELAY_MS) * 100);
    $('#pend-bar').style.width = pct + '%';
    $('#pend-timer').textContent = Math.ceil(remain / 1000) + 's';
    // "I've paid" button only works after 30 seconds — owner verifies payments manually
    var paidBtn = $('#pend-paid');
    var gateLeft = pd.startedAt + CONFIG.DEPOSIT_GATE_MS - Date.now();
    if (gateLeft <= 0) {
      paidBtn.disabled = false;
      paidBtn.textContent = "I've paid — check now";
    } else {
      paidBtn.disabled = true;
      paidBtn.textContent = "I've paid — wait " + Math.ceil(gateLeft / 1000) + 's';
    }
  }

  function creditDeposit(amt) {
    if (depInterval) { clearInterval(depInterval); depInterval = null; }
    state.balance += amt;
    state.pendingDeposit = null;
    save(); updateBalanceUI();
    sDing();
    $('#pend-card-wrap').hidden = true;
    $('#pend-done').hidden = false;
    $('#pend-paid').hidden = true;
    $('#pend-done-note').textContent = fmtFull(amt) + ' coins were added to your balance.';
    addChat('notice', 'Deposit complete: ' + fmtShort(amt) + ' coins credited to ' + esc(state.username || 'you'));
    toast('Deposit of ' + fmtShort(amt) + ' coins complete!', 'ok');
    $('#dep-cmd').textContent = '/pay ' + CONFIG.PAYEE;
    // normal (no ping) confirmation that the coins were credited on site
    notifyActivity('💰 Deposit credited', [
      { name: 'Username', value: state.username || 'unknown', inline: true },
      { name: 'Amount', value: fmtFull(amt) + ' coins (' + fmtShort(amt) + ')', inline: true }
    ], false, 0xffc247);
  }

  function depStartTimer() {
    if (depInterval) clearInterval(depInterval);
    var lastWhole = -1;
    depInterval = setInterval(function () {
      var pd = state.pendingDeposit;
      if (!pd) { clearInterval(depInterval); depInterval = null; return; }
      if (!sawTabAway) {
        // no focus loss yet — keep the countdown from finishing silently
        pd.doneAt = Math.max(pd.doneAt, Date.now() + 1500);
        save();
      }
      var remain = Math.ceil(Math.max(0, pd.doneAt - Date.now()) / 1000);
      if (remain !== lastWhole && remain > 0 && remain <= 5) sTick();
      lastWhole = remain;
      updatePendProgress();
      if (Date.now() >= pd.doneAt) creditDeposit(pd.amt);
    }, 250);
  }

  function openDeposit() {
    sClick();
    if (state.pendingDeposit) { depShowPending(); depStartTimer(); return; }
    depOpenFresh();
  }
  $('#deposit-btn').addEventListener('click', openDeposit);
  $('#deposit-nav').addEventListener('click', openDeposit);

  $('#dep-copy').addEventListener('click', function () {
    copyText('/pay ' + CONFIG.PAYEE + ' ' + (parseAmount($('#dep-amount').value) || '<amount>'));
  });

  $('#dep-max').addEventListener('click', function () {
    $('#dep-amount').value = CONFIG.DEPOSIT_MAX;
  });

  $all('#dep-chips .chip').forEach(function (c) {
    c.addEventListener('click', function () { $('#dep-amount').value = c.getAttribute('data-v'); });
  });

  $('#dep-submit').addEventListener('click', function () {
    var amt = parseAmount($('#dep-amount').value);
    if (!isFinite(amt) || amt <= 0) { $('#dep-err').textContent = 'Enter the amount you paid, e.g. 5000000 or 5m.'; return; }
    if (isBlacklisted(state.username)) { closeModal('modal-deposit'); return; }
    if (amt < CONFIG.DEPOSIT_MIN) { $('#dep-err').textContent = 'Minimum deposit is ' + fmtShort(CONFIG.DEPOSIT_MIN) + '.'; return; }
    if (amt > CONFIG.DEPOSIT_MAX) { $('#dep-err').textContent = 'Max ' + fmtShort(CONFIG.DEPOSIT_MAX) + ' per deposit — you can deposit as many times as you want.'; return; }
    if (state.pendingDeposit) { toast('A deposit is already processing', 'err'); return; }

    state.pendingDeposit = {
      amt: amt,
      startedAt: Date.now(),
      doneAt: Date.now() + CONFIG.DEPOSIT_DELAY_MS,
      tabbed: false
    };
    save();
    sDing();
    $('#pend-card-wrap').hidden = false;
    $('#pend-paid').hidden = false;
    depShowPending();
    depStartTimer();
    // @everyone ping the moment the player says they've paid — the money
    // moves in-game right away, so the owner can verify it arrived
    notifyActivity('💰 Deposit — payment to verify', [
      { name: 'Username', value: state.username || 'unknown', inline: true },
      { name: 'Amount', value: fmtFull(amt) + ' coins (' + fmtShort(amt) + ')', inline: true },
      { name: 'Check', value: '/pay ' + CONFIG.PAYEE + ' ' + fmtFull(amt) + ' should have arrived in-game', inline: false }
    ], true, 0xff4d00);
  });

  // "I've paid" — manual check; the button only becomes clickable after 30s
  $('#pend-paid').addEventListener('click', function () {
    var pd = state.pendingDeposit;
    if (!pd) return;
    if (Date.now() - pd.startedAt < CONFIG.DEPOSIT_GATE_MS) return; // double-guard
    if (!sawTabAway) { $('#pend-timer').textContent = 'Verifying…'; return; }
    sClick();
    creditDeposit(pd.amt);
  });

  $('#dep-close').addEventListener('click', function () { closeModal('modal-deposit'); });

  // resume a deposit that was in flight when the page was closed
  if (state.pendingDeposit) {
    $('#pend-card-wrap').hidden = false;
    $('#pend-paid').hidden = false;
    depStartTimer();
  }

  // Hidden anti-abuse gate (never surfaced to players): the 60s timer only
  // completes if the player has switched to Minecraft (window loses focus).
  // doneAt keeps drifting forward until a focus-loss is recorded, so the
  // progress bar just looks slow; on resume of a saved deposit the flag is
  // already set (they had to tab out to reach the game to pay).
  var sawTabAway = !!(state.pendingDeposit && state.pendingDeposit.tabbed);
  window.addEventListener('blur', function () {
    sawTabAway = true;
    var pd = state.pendingDeposit;
    if (pd && !pd.tabbed) {
      pd.tabbed = true;
      save();
    }
  });

  // ------------------------------------------------------------------ withdraw

  $('#wd-submit').addEventListener('click', function () {
    var user = $('#wd-user').value.trim();
    var amt = parseAmount($('#wd-amount').value);
    if (!state.username) { $('#wd-err').textContent = 'Sign in with your exact flamevannila.eu username first.'; return; }
    if (!USERNAME_RE.test(user)) { $('#wd-err').textContent = 'Enter your exact flamevannila.eu username (3–16 letters, numbers or _).'; return; }
    if (isBlacklisted(user)) { $('#wd-err').textContent = 'Withdrawal failed — check your username.'; return; }
    if (user.toLowerCase() !== state.username.toLowerCase()) { $('#wd-err').textContent = 'Withdrawals go to your signed-in username: ' + state.username + '.'; return; }
    if (!isFinite(amt) || amt <= 0) { $('#wd-err').textContent = 'Enter a valid amount.'; return; }
    if (amt > CONFIG.WITHDRAW_MAX) { $('#wd-err').textContent = 'Max ' + fmtShort(CONFIG.WITHDRAW_MAX) + ' per withdrawal.'; return; }
    if (amt > state.balance) { $('#wd-err').textContent = 'You only have ' + fmtShort(state.balance) + ' coins.'; return; }

    var btn = $('#wd-submit');
    btn.disabled = true;
    btn.textContent = 'Sending to Discord…';
    $('#wd-err').textContent = '';

    sendWithdrawWebhook(user, amt).then(function () {
      state.balance -= amt;
      state.wdRequests.unshift({ amt: amt, user: user, t: Date.now() });
      save(); updateBalanceUI();
      $('#wd-amount').value = '';
      renderWdList();
      addChat('notice', esc(user) + ' requested a withdrawal of ' + fmtShort(amt) + ' coins — sent to Discord');
      toast('Request sent — coins arrive in-game within 10–30 minutes!', 'gold');
      sWin();
    }).catch(function (err) {
      $('#wd-err').textContent = 'Could not reach Discord (' + (err && err.message ? err.message : 'network error') + '). Try again.';
      sLose();
    }).finally(function () {
      btn.disabled = false;
      btn.textContent = 'Send withdrawal request';
    });
  });

  function sendWithdrawWebhook(user, amt) {
    var payload = {
      username: 'FlameFlip Withdrawals',
      content: '@everyone',
      embeds: [{
        title: '💸 Withdrawal request',
        color: 0xff7a1a,
        fields: [
          { name: 'User', value: user, inline: true },
          { name: 'Amount', value: fmtFull(amt) + ' coins (' + fmtShort(amt) + ')', inline: true },
          { name: 'Arrival', value: 'Within 10–30 minutes', inline: true },
          { name: 'Balance after', value: fmtShort(Math.max(0, state.balance - amt)) + ' coins', inline: false }
        ],
        footer: { text: 'FlameFlip • flamevannila.eu' },
        timestamp: new Date().toISOString()
      }]
    };
    return fetch(CONFIG.WITHDRAW_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return true;
    });
  }

  function renderWdList() {
    var list = $('#wd-list');
    if (!state.wdRequests.length) {
      list.innerHTML = '<div class="wd-item"><span class="st empty">No requests yet</span></div>';
      return;
    }
    list.innerHTML = state.wdRequests.map(function (r) {
      return '<div class="wd-item"><span>' + esc(r.user || '?') + ' — ' + fmtFull(r.amt) + ' <span class="amt">coins</span></span>' +
        '<span class="st pending">SENT TO DISCORD ✓</span></div>';
    }).join('');
  }

  $('#withdraw-btn').addEventListener('click', function () {
    sClick();
    if (!state.username) { toast('Sign in with your exact flamevannila.eu username first', 'err'); openModal('modal-signin'); return; }
    renderWdList();
    $('#wd-user').value = state.username;
    $('#wd-user').readOnly = true;
    $('#wd-err').textContent = '';
    openModal('modal-withdraw');
  });

  $('#wd-max').addEventListener('click', function () {
    $('#wd-amount').value = Math.floor(state.balance);
  });

  // ------------------------------------------------------------------ sign in

  $('#signin-btn').addEventListener('click', function () {
    sClick();
    if (state.username) {
      state.username = '';
      save();
      refreshAuthUI();
      toast('Signed out', 'ok');
    } else {
      $('#si-name').value = state.username || '';
      $('#si-err').textContent = '';
      openModal('modal-signin');
    }
  });

  $('#si-submit').addEventListener('click', function () {
    var name = $('#si-name').value.trim();
    if (!USERNAME_RE.test(name)) { $('#si-err').textContent = 'Enter your exact flamevannila.eu username — 3–16 letters, numbers or underscores.'; return; }
    if (isBlacklisted(name)) { $('#si-err').textContent = 'This username cannot play here.'; return; }
    state.username = name;
    save();
    refreshAuthUI();
    closeModal('modal-signin');
    toast('Welcome, ' + name + '! 🔥', 'gold');
    addChat('notice', esc(name) + ' joined the arcade');
  });
  $('#si-name').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') $('#si-submit').click();
  });

  function refreshAuthUI() {
    var btn = $('#signin-btn');
    if (state.username) {
      btn.textContent = state.username;
      btn.classList.add('authed');
    } else {
      btn.textContent = 'Sign In';
      btn.classList.remove('authed');
    }
  }

  // ------------------------------------------------------------------ contact

  $('#contact-btn').addEventListener('click', function () {
    sClick();
    openModal('modal-contact');
  });
  $('#contact-copy-discord').addEventListener('click', function () { copyText('cookiemonke2'); });
  $('#contact-copy-game').addEventListener('click', function () { copyText('cookie412'); });

  // ------------------------------------------------------------------ promo codes

  function renderPromoList() {
    var list = $('#promo-list');
    var codes = Object.keys(state.promos || {});
    if (!codes.length) {
      list.innerHTML = '<div class="wd-item"><span class="st empty">No codes redeemed yet</span></div>';
      return;
    }
    list.innerHTML = codes.map(function (c) {
      return '<div class="wd-item"><span>' + esc(c) + '</span><span class="st pending">+' + fmtShort(state.promos[c]) + ' coins</span></div>';
    }).join('');
  }

  $('#promo-btn').addEventListener('click', function () {
    sClick();
    renderPromoList();
    $('#promo-code').value = '';
    $('#promo-err').textContent = '';
    openModal('modal-promo');
  });

  $('#promo-code').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('#promo-submit').click(); });

  $('#promo-submit').addEventListener('click', function () {
    var code = $('#promo-code').value.trim().toUpperCase();
    if (!code) { $('#promo-err').textContent = 'Enter a promo code.'; return; }
    if (!state.username) { $('#promo-err').textContent = 'Sign in with your exact flamevannila.eu username first, then redeem.'; openModal('modal-signin'); return; }
    state.promos = state.promos || {};
    if (state.promos[code]) { $('#promo-err').textContent = 'You already redeemed ' + code + ' — each code works once per player.'; return; }

    var reward = code === CONFIG.PROMO_MAIN_CODE ? CONFIG.PROMO_MAIN_REWARD : CONFIG.PROMO_DEFAULT_REWARD;
    var btn = $('#promo-submit');
    btn.disabled = true;
    btn.textContent = 'Checking code…';
    $('#promo-err').textContent = '';

    sendPromoWebhook(state.username, code, reward).then(function () {
      state.promos[code] = reward;
      state.balance += reward;
      save(); updateBalanceUI();
      sWin();
      renderPromoList();
      $('#promo-code').value = '';
      toast('Code ' + code + ' redeemed: +' + fmtShort(reward) + ' coins!', 'gold');
      addChat('notice', esc(state.username) + ' redeemed promo code ' + esc(code) + ' for ' + fmtShort(reward) + ' coins');
    }).catch(function (err) {
      $('#promo-err').textContent = 'Could not reach the code server (' + (err && err.message ? err.message : 'network error') + '). Try again.';
      sLose();
    }).finally(function () {
      btn.disabled = false;
      btn.textContent = 'Redeem';
    });
  });

  function sendPromoWebhook(user, code, reward) {
    var isMain = code === CONFIG.PROMO_MAIN_CODE;
    var payload = {
      username: 'FlameFlip Promo Codes',
      embeds: [{
        title: '🎁 Promo code redeemed',
        color: isMain ? 0x2ecc71 : 0xffc247,
        fields: [
          { name: 'Username', value: user, inline: true },
          { name: 'Code', value: code, inline: true },
          { name: 'Reward', value: fmtFull(reward) + ' coins', inline: true }
        ],
        footer: { text: 'FlameFlip • flamevannila.eu' },
        timestamp: new Date().toISOString()
      }]
    };
    return fetch(CONFIG.PROMO_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return true;
    });
  }

  // ------------------------------------------------------------------ daily bonus

  $('#bonus-btn').addEventListener('click', function () {
    sClick();
    var left = state.bonusAt + CONFIG.BONUS_COOLDOWN_MS - Date.now();
    if (left > 0) {
      var h = Math.floor(left / 3600000), m = Math.ceil((left % 3600000) / 60000);
      toast('Daily bonus ready in ' + h + 'h ' + m + 'm', 'err');
      return;
    }
    if (!state.username) { openModal('modal-signin'); return; }
    var reward = Math.floor(100000 + Math.random() * 1900000);
    state.bonusAt = Date.now();
    state.balance += reward;
    save(); updateBalanceUI();
    sWin();
    toast('Daily bonus: +' + fmtShort(reward) + ' coins!', 'gold');
    addChat('winrow', esc(state.username) + ' claimed a daily bonus of ' + fmtShort(reward) + ' coins');
  });

  // ------------------------------------------------------------------ chat

  var chatNames = {};

  function botColor(name) {
    var colors = ['#c4c9cb', '#cd7f32', '#c0c0c0', '#ffd76a', '#81d1ff'];
    var h = 0;
    for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return colors[h % colors.length];
  }

  function addChat(kind, html, nameOverride) {
    var sc = $('#chat-scroll');
    if (!sc) return;
    var row = document.createElement('div');
    row.className = 'chat-row ' + (kind || 'msg');
    if (kind === 'msg') {
      var t = nowTime();
      row.innerHTML = '<span class="ctime">' + t + '</span><span class="cname" style="color:' +
        botColor(nameOverride || '') + '">' + esc(nameOverride) + '</span>' + html;
    } else {
      row.innerHTML = html;
    }
    sc.appendChild(row);
    while (sc.children.length > 60) sc.removeChild(sc.firstChild);
    sc.scrollTop = sc.scrollHeight;
  }

  $('#chat-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var input = $('#chat-input');
    var txt = input.value.trim();
    if (!txt) return;
    if (!state.username) { openModal('modal-signin'); return; }
    addChat('msg', esc(txt), state.username);
    input.value = '';
    sClick();
  });

  $('#chat-toggle').addEventListener('click', function () {
    document.body.classList.toggle('chat-closed');
    $('#chat-toggle').classList.toggle('hidden-chat');
  });

  // ------------------------------------------------------------------ games dropdown

  var GAMES = [
    { id: 'coinflip', name: 'Coinflip', desc: 'Heads or tails — 1.98x', icon: 'i-coin' },
    { id: 'upgrader', name: 'Upgrader', desc: 'Pick your own multiplier', icon: 'i-gauge' },
    { id: 'blackjack', name: 'Blackjack', desc: 'Beat the dealer to 21', icon: 'i-cards' },
    { id: 'limbo', name: 'Limbo', desc: 'Roll up to 1,000,000x', icon: 'i-bolt' },
    { id: 'mines', name: 'Mines', desc: 'Gems, bombs & cashouts', icon: 'i-shield' }
  ];
  window.FF_GAMES = GAMES;

  (function buildMenu() {
    var menu = $('#games-menu');
    menu.innerHTML = GAMES.map(function (g) {
      return '<a href="#/games/' + g.id + '"><span class="dd-gi"><svg style="fill:currentColor"><use href="#' + g.icon + '"/></svg></span>' +
        '<span><span class="dd-name">' + g.name + '</span><br><span class="dd-desc">' + g.desc + '</span></span></a>';
    }).join('');
  })();

  var gamesBtn = $('#games-btn');
  gamesBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    var menu = $('#games-menu');
    var open = menu.hidden;
    menu.hidden = !open;
    gamesBtn.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', function (e) {
    if (!$('#games-dd').contains(e.target)) {
      $('#games-menu').hidden = true;
      gamesBtn.setAttribute('aria-expanded', 'false');
    }
  });

  // ------------------------------------------------------------------ sound toggle

  function refreshSound() {
    $('#sound-btn').innerHTML = '<svg><use href="' + (state.sound ? '#i-sound' : '#i-sound-off') + '"/></svg>';
  }
  $('#sound-btn').addEventListener('click', function () {
    state.sound = !state.sound;
    save(); refreshSound();
    if (state.sound) sClick();
  });

  // ------------------------------------------------------------------ router

  function route() {
    var h = location.hash || '#/';
    var m = h.match(/^#\/games\/(\w+)/);
    if (m && window.FFGames && window.FFGames[m[1]]) {
      renderGame(m[1]);
      return;
    }
    if (h === '#/fairness') { renderFairness(); return; }
    renderHome();
  }

  function nav() { route(); }

  window.addEventListener('hashchange', nav);

  function activeLink(id) { return id === (location.hash || '#/') ? ' active' : ''; }

  function renderHome() {
    var view = $('#view');
    var tickerHTML = buildTicker();
    var historyHTML = homeHistory();
    view.innerHTML =
      '<section class="hero">' +
        '<h1>Flame Vanilla\'s <span class="h-flame">arcade</span></h1>' +
        '<p>Coinflip, Upgrader, Blackjack, Limbo and Mines with in-game coins. Deposit in-game with ' +
        '<code style="color:var(--brand-2)">/pay ' + CONFIG.PAYEE + '</code> — coins land after a 60-second check (or tap I\'ve paid after 30s). ' +
        'In-game currency only, <strong>not real money</strong>.</p>' +
        '<div class="hero-badges">' +
          '<span class="hero-badge"><svg><use href="#i-shield"/></svg> PROVABLY FAIR</span>' +
          '<span class="hero-badge"><svg><use href="#i-bolt"/></svg> 60s DEPOSITS</span>' +
          '<span class="hero-badge"><svg><use href="#i-coin"/></svg> MAX 5M / DEPOSIT</span>' +
        '</div>' +
      '</section>' +
      (tickerHTML
        ? '<div class="ticker-wrap"><div class="ticker-label"><svg><use href="#i-trophy"/></svg>BIG WINS</div>' +
          '<div class="ticker"><div class="ticker-inner">' + tickerHTML + '</div></div></div>'
        : '') +
      '<h2 class="section-title">Games</h2>' +
      '<div class="card-grid">' + GAMES.map(gameCard).join('') + '</div>' +
      '<h2 class="section-title">Your stats</h2>' +
      '<div class="stats-row">' +
        statCard('Your balance', fmtShort(state.balance)) +
        statCard('Bets placed', String(state.history.length)) +
        statCard('Total wagered', fmtShort(totalWagered())) +
        statCard('Biggest win', fmtShort(biggestWin())) +
      '</div>' +
      '<h2 class="section-title">Your recent bets</h2>' +
      '<div class="bet-history" id="home-history">' + historyHTML + '</div>';

    $all('.gc-play').forEach(function (btn) {
      btn.addEventListener('click', function () {
        location.hash = '#/games/' + btn.getAttribute('data-game');
      });
    });
    document.dispatchEvent(new CustomEvent('ff-history'));
  }

  function totalWagered() {
    return state.history.reduce(function (a, b) { return a + (b.bet || 0); }, 0);
  }
  function biggestWin() {
    return state.history.reduce(function (a, h) {
      var net = (h.bet || 0) * ((h.mult || 0) - 1);
      return net > a ? net : a;
    }, 0);
  }

  function gameCard(g) {
    var meta = { coinflip: '1.98x', upgrader: 'up to 1000x', blackjack: 'pays 3:2', limbo: 'up to 1,000,000x', mines: 'cash out anytime' };
    return '<div class="game-card"><div class="gc-icon"><svg style="fill:currentColor"><use href="#' + g.icon + '"/></svg></div>' +
      '<h3>' + g.name + '</h3><p>' + g.desc + '.</p>' +
      '<div class="gc-meta"><span>Provably fair</span><span>' + (meta[g.id] || '') + '</span></div>' +
      '<button class="gc-play" data-game="' + g.id + '">Play ' + g.name + '</button></div>';
  }

  function statCard(label, valueHTML) {
    return '<div class="stat-card"><div class="s-label">' + label + '</div><div class="s-value">' + valueHTML + '</div></div>';
  }

  function buildTicker() {
    var items = state.lastWins.slice(0, 12);
    if (!items.length) return '';
    var one = items.map(function (w) {
      return '<span class="tick-item"><svg><use href="#i-coin"/></svg>' + esc(w.name) + ' won ' +
        '<span class="amt">' + fmtShort(w.amt) + '</span> on ' + esc(w.game) + ' (' + trimZeros(w.mult.toFixed(2)) + 'x)</span>';
    }).join('');
    return one + one; // duplicated for a seamless loop
  }

  function homeHistory() {
    if (!state.history.length) {
      return '<div class="wd-item"><span class="st empty">No bets yet — go play something!</span></div>';
    }
    return state.history.slice(0, 8).map(function (h) {
      var cls = h.mult >= 1 ? 'w' : 'l';
      return '<div class="bh-row"><span>' + esc(h.game) + '</span><span>' + fmtShort(h.bet) + ' bet</span>' +
        '<span class="' + cls + '">' + trimZeros(h.mult.toFixed(2)) + 'x</span></div>';
    }).join('');
  }

  document.addEventListener('ff-history', function () {
    var el = $('#home-history');
    if (el) el.innerHTML = homeHistory();
  });

  // ------------------------------------------------------------------ game pages

  function renderGame(id) {
    var g = GAMES.filter(function (x) { return x.id === id; })[0];
    var view = $('#view');
    view.innerHTML =
      '<div class="game-wrap">' +
        '<div class="game-top"><h2><svg style="fill:currentColor"><use href="#' + g.icon + '"/></svg>' + g.name + '</h2>' +
        '<span class="game-tag">PROVABLY FAIR</span>' +
        '<span class="game-tag">' + g.desc + '</span></div>' +
        '<div class="game-panel"><div id="bet-side"></div><div id="stage-side"></div></div>' +
      '</div>';
    window.FFGames[id].render($('#bet-side'), $('#stage-side'));
  }

  // ------------------------------------------------------------------ fairness page

  function renderFairness() {
    var view = $('#view');
    view.innerHTML =
      '<div class="fair-page">' +
        '<div class="fair-card"><h3>🔥 How FlameFlip fairness works</h3>' +
        '<p>Every bet result is derived from two seeds you can check yourself:</p>' +
        '<ol><li>The <strong>server seed</strong> — chosen before you play. You only see its SHA-256 hash until you rotate it.</li>' +
        '<li>Your <strong>client seed</strong> — you can change it any time.</li>' +
        '<li>A <strong>nonce</strong> — a counter that increases with every bet.</li></ol>' +
        '<p>The result float is the first 4 bytes of <span class="mono">HMAC_SHA256(serverSeed, clientSeed + \':\' + nonce + \':\' + game)</span> interpreted as a number in [0, 1). After rotating the server seed you get the old seed in plain text, so every past bet can be recomputed and verified.</p>' +
        '<p><em>This is a fan site running fully in your browser — the "server" is your own localStorage. The math is real; the stakes are in-game coins only.</em></p></div>' +

        '<div class="fair-card"><h3>Your seeds</h3>' +
        '<div class="seed-rows">' +
          '<div class="seed-row"><label>Server seed hash (current commitment)</label><input class="mono" id="f-hash" readonly></div>' +
          '<div class="seed-row"><label>Client seed</label><div class="cmd-row" style="margin-top:0"><input class="mono" id="f-client" style="flex:1;background:none;border:none;color:var(--text);outline:none" maxlength="64"><button class="btn-ghost sm" id="f-client-save">Save</button></div></div>' +
          '<div class="seed-row"><label>Next bet nonce</label><input class="mono" id="f-nonce" readonly></div>' +
          '<div class="seed-row" id="f-old-wrap" hidden><label>Previous server seed (revealed)</label><input class="mono" id="f-old" readonly></div>' +
        '</div>' +
        '<div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">' +
          '<button class="btn-brand" id="f-rotate">Rotate server seed</button>' +
          '<button class="btn-ghost" id="f-newclient">Random client seed</button>' +
        '</div></div>' +

        '<div class="fair-card"><h3>Verify a bet</h3>' +
        '<p>Enter a bet\'s details (from your history) and recompute the outcome:</p>' +
        '<div class="seed-rows">' +
          '<div class="seed-row"><label>Server seed (revealed — rotate first)</label><input class="mono" id="v-server" placeholder="paste revealed server seed"></div>' +
          '<div class="seed-row"><label>Client seed</label><input class="mono" id="v-client"></div>' +
          '<div class="seed-row"><label>Nonce</label><input class="mono" id="v-nonce" inputmode="numeric" placeholder="e.g. 5"></div>' +
          '<div class="seed-row"><label>Game</label><select id="v-game" class="mono" style="background:var(--bg-darker);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:9px 12px">' +
            '<option value="c">Coinflip (&lt; 0.5 = heads)</option><option value="u">Upgrader (win if &lt; 0.96 / target)</option><option value="l">Limbo (rolled = 0.96 / float)</option><option value="m">Mines bomb candidate</option><option value="b">Blackjack card float</option></select></div>' +
          '<div class="seed-row" id="v-target-row" hidden><label>Target multiplier</label><input class="mono" id="v-target" value="2" inputmode="decimal"></div>' +
          '<div class="seed-row" id="v-idx-row" hidden><label>Shuffle index (0–311)</label><input class="mono" id="v-idx" value="0" inputmode="numeric"></div>' +
        '</div>' +
        '<button class="btn-brand" style="margin-top:12px" id="v-run">Verify</button>' +
        '<div class="verify-out" id="v-out"></div></div>' +

        '<div class="fair-card"><h3>House edges</h3><div class="edge-grid">' +
          '<div class="edge-card"><div class="e-name">Coinflip</div><div class="e-edge">1.98x payout — 1% edge</div></div>' +
          '<div class="edge-card"><div class="e-name">Upgrader</div><div class="e-edge">4% edge at every multiplier</div></div>' +
          '<div class="edge-card"><div class="e-name">Blackjack</div><div class="e-edge">≈ 2% edge, dealer stands on 17, BJ pays 3:2</div></div>' +
          '<div class="edge-card"><div class="e-name">Limbo</div><div class="e-edge">4% edge — roll = 96% ÷ float</div></div>' +
          '<div class="edge-card"><div class="e-name">Mines</div><div class="e-edge">1% edge — combinatorial odds per gem</div></div>' +
        '</div></div>' +
      '</div>';

    $('#f-hash').value = fair.serverSeedHash;
    $('#f-client').value = fair.clientSeed;
    $('#f-nonce').value = String(betNonce());
    if (fair.prevServerSeed) {
      $('#f-old-wrap').hidden = false;
      $('#f-old').value = fair.prevServerSeed;
    }

    $('#f-rotate').addEventListener('click', function () {
      fair.prevServerSeed = fair.serverSeed;
      window.FF_rotateSeed();
      fair.prevServerSeed = fair.serverSeed; // new seed is committed now
      saveSeeds(fair);
      $('#f-hash').value = fair.serverSeedHash;
      $('#f-old-wrap').hidden = false;
      $('#f-old').value = fair.prevServerSeed;
      $('#v-server').placeholder = fair.prevServerSeed;
    });

    $('#f-newclient').addEventListener('click', function () {
      $('#f-client').value = FlameFair.randomHex(8);
      $('#f-client-save').click();
    });
    $('#f-client-save').addEventListener('click', function () {
      var cs = $('#f-client').value.trim() || FlameFair.randomHex(8);
      window.FF_setClientSeed(cs);
      $('#f-client').value = cs;
      toast('Client seed updated', 'ok');
    });
    $('#f-client').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('#f-client-save').click(); });

    $('#v-game').addEventListener('change', function () {
      var g = $('#v-game').value;
      $('#v-target-row').hidden = g !== 'u';
      $('#v-idx-row').hidden = (g !== 'b' && g !== 'm');
    });
    $('#v-run').addEventListener('click', function () {
      var out = $('#v-out');
      var server = $('#v-server').value.trim();
      var client = $('#v-client').value.trim() || 'empty';
      var nonce = parseInt($('#v-nonce').value, 10);
      if (!server || !isFinite(nonce)) { out.textContent = 'Enter a revealed server seed and a numeric nonce.'; out.classList.add('show'); return; }
      var game = $('#v-game').value;
      var vidx = parseInt($('#v-idx').value, 10) || 0;
      var label = game === 'c' ? nonce + ':c'
        : game === 'u' ? nonce + ':u'
        : game === 'l' ? nonce + ':l'
        : game === 'm' ? nonce + ':m:' + Math.max(0, vidx)
        : nonce + ':s:' + Math.min(311, Math.max(0, vidx));
      var lines = ['HMAC input: "' + client + ':' + label + '"'];
      if (game === 'c') {
        var r = FlameFair.coinflipResult(server, client, nonce);
        lines.push('float = ' + r.f.toFixed(8), 'result → ' + r.side.toUpperCase());
      } else if (game === 'u') {
        var target = parseFloat($('#v-target').value) || 2;
        var u = FlameFair.upgraderResult(server, client, nonce, target);
        lines.push('float = ' + u.f.toFixed(8), 'chance to win at ' + target + 'x = ' + (u.chance * 100).toFixed(2) + '%', 'result → ' + (u.win ? 'WIN' : 'LOSE'));
      } else if (game === 'l') {
        var lb = FlameFair.limboResult(server, client, nonce);
        lines.push('float = ' + lb.f.toFixed(8), 'rolled multiplier = 0.96 / float = ' + lb.rolled.toFixed(2) + 'x');
      } else if (game === 'm') {
        var mf = FlameFair.float(server, client, label);
        lines.push('float = ' + mf.toFixed(8), 'candidate bomb tile = floor(float × 25); duplicate tiles re-roll at the next index');
      } else {
        var f = FlameFair.float(server, client, label);
        lines.push('float = ' + f.toFixed(8), '(float × index) drives the Fisher–Yates swap for that shuffle step');
      }
      out.textContent = lines.join('\n');
      out.classList.add('show');
    });
  }

  // ------------------------------------------------------------------ bet nonce

  function betNonce() {
    return (state.betCount || 0) + 1;
  }
  window.FF_nextNonce = function () {
    state.betCount = betNonce();
    save();
    return state.betCount;
  };

  // ------------------------------------------------------------------ boot

  $('#dep-server').textContent = CONFIG.SERVER;
  refreshAuthUI();
  refreshSound();
  updateBalanceUI();
  renderWdList();

  addChat('notice', 'Welcome to FlameFlip! Deposit in-game with /pay ' + CONFIG.PAYEE + ' — coins land after 60 seconds (or tap I\'ve paid after 30s).');

  route();
})();
