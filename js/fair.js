/*
 * FlameFlip — provably-fair core.
 *
 * Pure-JS SHA-256 + HMAC-SHA256 (synchronous, no dependencies), so the same
 * math runs in the browser and in Node for tests.
 *
 * Fairness model (demo): every bet derives its randomness from
 *   HMAC_SHA256(serverSeed, clientSeed + ':' + label)
 * where `label` is the bet nonce plus a per-game suffix, e.g. "12:c" for
 * coinflip, "12:u" for upgrader, "12:s:57" for the 57th card shuffle step in
 * blackjack. The first 4 bytes of the digest become a float in [0, 1).
 *
 * The current serverSeed is committed to with its SHA-256 hash before play;
 * rotating the seed reveals the old seed so past bets can be re-verified.
 */
(function () {
  'use strict';

  var root = typeof window !== 'undefined' ? window : globalThis;

  // ------------------------------------------------------------------ SHA-256

  var K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]);

  function rotr(x, n) {
    return (x >>> n) | (x << (32 - n));
  }

  function sha256Bytes(msgBytes) {
    var l = msgBytes.length;
    var blocks = ((l + 8) >> 6) + 1;
    var total = blocks * 64;
    var buf = new Uint8Array(total);
    buf.set(msgBytes);
    buf[l] = 0x80;
    var dv = new DataView(buf.buffer);
    // 64-bit big-endian bit length (high, low)
    dv.setUint32(total - 8, Math.floor(l / 0x20000000));
    dv.setUint32(total - 4, (l << 3) >>> 0);

    var H = new Uint32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    ]);
    var w = new Uint32Array(64);

    for (var off = 0; off < total; off += 64) {
      var i;
      for (i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
      for (i = 16; i < 64; i++) {
        var s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        var s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3];
      var e = H[4], f = H[5], g = H[6], h = H[7];
      for (i = 0; i < 64; i++) {
        var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        var ch = (e & f) ^ (~e & g);
        var t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
        var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0;
        d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0;
      H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
      H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0;
      H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
    }

    var out = new Uint8Array(32);
    for (i = 0; i < 8; i++) {
      out[i * 4] = (H[i] >>> 24) & 255;
      out[i * 4 + 1] = (H[i] >>> 16) & 255;
      out[i * 4 + 2] = (H[i] >>> 8) & 255;
      out[i * 4 + 3] = H[i] & 255;
    }
    return out;
  }

  var enc = new TextEncoder();

  function utf8(str) {
    return enc.encode(str);
  }

  function concat(a, b) {
    var out = new Uint8Array(a.length + b.length);
    out.set(a);
    out.set(b, a.length);
    return out;
  }

  function bytesToHex(bytes) {
    var hex = '';
    for (var i = 0; i < bytes.length; i++) {
      hex += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    }
    return hex;
  }

  function sha256Hex(str) {
    return bytesToHex(sha256Bytes(utf8(str)));
  }

  // -------------------------------------------------------------- HMAC-SHA256

  function hmacBytes(keyStr, msgStr) {
    var key = utf8(keyStr);
    if (key.length > 64) key = sha256Bytes(key);
    var ipad = new Uint8Array(64);
    var opad = new Uint8Array(64);
    ipad.fill(0x36);
    opad.fill(0x5c);
    for (var i = 0; i < key.length; i++) {
      ipad[i] ^= key[i];
      opad[i] ^= key[i];
    }
    var inner = sha256Bytes(concat(ipad, utf8(msgStr)));
    return sha256Bytes(concat(opad, inner));
  }

  function hmacHex(keyStr, msgStr) {
    return bytesToHex(hmacBytes(keyStr, msgStr));
  }

  // ------------------------------------------------------------------- floats

  // Deterministic float in [0, 1) from the first 4 bytes of the HMAC digest.
  function float(serverSeed, clientSeed, label) {
    var h = hmacBytes(serverSeed, clientSeed + ':' + label);
    var v = ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0;
    return v / 4294967296;
  }

  function randomHex(nBytes) {
    var bytes = new Uint8Array(nBytes);
    if (root.crypto && root.crypto.getRandomValues) {
      root.crypto.getRandomValues(bytes);
    } else {
      for (var i = 0; i < nBytes; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    return bytesToHex(bytes);
  }

  function newSeed() {
    var serverSeed = randomHex(32);
    return {
      serverSeed: serverSeed,
      serverSeedHash: sha256Hex(serverSeed),
      clientSeed: randomHex(8)
    };
  }

  // ---------------------------------------------------------- game algorithms

  // Coinflip: heads when float < 0.5. Label: "<nonce>:c"
  function coinflipResult(serverSeed, clientSeed, nonce) {
    var f = float(serverSeed, clientSeed, nonce + ':c');
    return { f: f, side: f < 0.5 ? 'heads' : 'tails' };
  }

  // Upgrader: win when float < 0.96 / target. Label: "<nonce>:u"
  function upgraderResult(serverSeed, clientSeed, nonce, target) {
    var f = float(serverSeed, clientSeed, nonce + ':u');
    var chance = 0.96 / target;
    return { f: f, chance: chance, win: f < chance };
  }

  // Blackjack: fresh 6-deck shoe (312 cards) shuffled with Fisher-Yates.
  // Card encode: suit = floor(c / 13) (0 spades, 1 hearts, 2 diamonds, 3 clubs),
  // rank = c % 13 (0 = Ace ... 12 = King). Label per swap: "<nonce>:s:<i>"
  function blackjackShoe(serverSeed, clientSeed, nonce) {
    var cards = new Array(312);
    for (var i = 0; i < 312; i++) cards[i] = i % 52;
    for (var j = cards.length - 1; j > 0; j--) {
      var r = float(serverSeed, clientSeed, nonce + ':s:' + j);
      var k = Math.floor(r * (j + 1));
      var tmp = cards[j];
      cards[j] = cards[k];
      cards[k] = tmp;
    }
    return cards;
  }

  // Limbo: rolled multiplier = 0.96 / float (4% edge). Win when rolled >= target.
  // Label: "<nonce>:l"
  function limboResult(serverSeed, clientSeed, nonce) {
    var f = float(serverSeed, clientSeed, nonce + ':l');
    var rolled = f <= 0 ? Number.POSITIVE_INFINITY : 0.96 / f;
    return { f: f, rolled: rolled };
  }

  // Mines: `count` unique bomb positions on a 25-tile board. Each candidate
  // position is floor(float × 25) from one HMAC float, label "<nonce>:m:<i>";
  // duplicate positions are re-rolled with the next index.
  function minesLayout(serverSeed, clientSeed, nonce, count) {
    count = Math.max(1, Math.min(24, Math.floor(count)));
    var picked = {};
    var out = [];
    var i = 0;
    while (out.length < count && i < 500) {
      var pos = Math.floor(float(serverSeed, clientSeed, nonce + ':m:' + i) * 25);
      if (pos > 24) pos = 24; // float is < 1, guard anyway
      if (!picked[pos]) { picked[pos] = true; out.push(pos); }
      i++;
    }
    return out;
  }

  var SUITS = ['\u2660', '\u2665', '\u2666', '\u2663'];
  var RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

  function cardName(card) {
    return RANKS[card % 13] + SUITS[Math.floor(card / 13)];
  }

  root.FlameFair = {
    sha256Hex: sha256Hex,
    hmacHex: hmacHex,
    float: float,
    newSeed: newSeed,
    randomHex: randomHex,
    coinflipResult: coinflipResult,
    upgraderResult: upgraderResult,
    limboResult: limboResult,
    minesLayout: minesLayout,
    blackjackShoe: blackjackShoe,
    cardName: cardName,
    SUITS: SUITS,
    RANKS: RANKS
  };
})();
