/* Canvas charts for Home (line), Coin (candles), and the analyst score ring.
   devicePixelRatio aware. No chart library. */
(function (global) {
  "use strict";

  var GREEN = "#00d35a";
  var RED = "#ff453a";
  var ORANGE = "#ff9f0a";
  var BLUE = "#0a84ff";
  var GRID = "rgba(84,84,88,0.45)";
  var MUTED = "rgba(235,235,245,0.3)";

  function dpr(canvas, cssW, cssH) {
    var r = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(cssW * r));
    canvas.height = Math.max(1, Math.round(cssH * r));
    canvas.style.width = cssW + "px";
    canvas.style.height = cssH + "px";
    var ctx = canvas.getContext("2d");
    ctx.setTransform(r, 0, 0, r, 0, 0);
    return ctx;
  }

  function niceRange(min, max) {
    if (min === max) {
      var pad = Math.abs(min) * 0.05 || 1;
      return { min: min - pad, max: max + pad };
    }
    var span = max - min;
    return { min: min - span * 0.08, max: max + span * 0.12 };
  }

  function drawLineChart(canvas, data, opts) {
    opts = opts || {};
    var box = canvas.parentElement.getBoundingClientRect();
    var w = box.width;
    var h = box.height;
    var ctx = dpr(canvas, w, h);
    ctx.clearRect(0, 0, w, h);
    var padL = 2, padR = 2, padT = 18, padB = 18;
    var points = (data && data.points) || [];
    var marks = (data && data.marks) || [];
    var startVal = data && data.start_value;
    var reduced = !!(opts.reduced);

    if (!points.length) {
      ctx.save();
      ctx.setLineDash([5, 6]);
      ctx.strokeStyle = MUTED;
      ctx.lineWidth = 1;
      var y = Math.round(h * 0.55) + 0.5;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(w - padR, y);
      ctx.stroke();
      ctx.restore();
      return;
    }

    var vals = points.map(function (p) { return Number(p.value); });
    if (startVal != null) vals.push(Number(startVal));
    var ext = niceRange(Math.min.apply(null, vals), Math.max.apply(null, vals));
    var min = ext.min, max = ext.max;
    var x0 = padL, x1 = w - padR, y0 = padT, y1 = h - padB;
    function X(i, n) { return n <= 1 ? (x0 + x1) / 2 : x0 + (x1 - x0) * (i / (n - 1)); }
    function Y(v) { return y1 - ((v - min) / (max - min)) * (y1 - y0); }

    if (startVal != null) {
      ctx.save();
      ctx.setLineDash([4, 5]);
      ctx.strokeStyle = MUTED;
      ctx.lineWidth = 1;
      var sy = Math.round(Y(Number(startVal))) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x0, sy);
      ctx.lineTo(x1, sy);
      ctx.stroke();
      ctx.restore();
    }

    var n = points.length;
    ctx.beginPath();
    for (var i = 0; i < n; i++) {
      var x = X(i, n), y = Y(vals[i]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.lineTo(X(n - 1, n), y1);
    ctx.lineTo(X(0, n), y1);
    ctx.closePath();
    var grad = ctx.createLinearGradient(0, y0, 0, y1);
    grad.addColorStop(0, "rgba(0,211,90,0.28)");
    grad.addColorStop(1, "rgba(0,211,90,0)");
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    for (i = 0; i < n; i++) {
      x = X(i, n); y = Y(vals[i]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = GREEN;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke();

    // Marks: later marks move up a row so they never overlap.
    var used = {};
    marks.forEach(function (m, idx) {
      var ts = m.ts;
      var nearest = 0, best = Infinity;
      for (var j = 0; j < points.length; j++) {
        var d = Math.abs(Date.parse(points[j].ts) - Date.parse(ts));
        if (d < best) { best = d; nearest = j; }
      }
      var mx = X(nearest, n);
      var col = m.color === "red" ? RED : m.color === "blue" ? BLUE : GREEN;
      var row = 0;
      var key = String(Math.round(mx / 10));
      row = used[key] || 0;
      used[key] = row + 1;
      var my = y0 + 10 + row * 12;
      ctx.font = "11px -apple-system, BlinkMacSystemFont, sans-serif";
      ctx.fillStyle = col;
      ctx.globalAlpha = reduced ? 1 : 1;
      ctx.textAlign = "center";
      ctx.fillText(m.label || "", mx, my);
    });
  }

  function drawCandles(canvas, data, opts) {
    opts = opts || {};
    var box = canvas.parentElement.getBoundingClientRect();
    var w = box.width, h = box.height;
    var ctx = dpr(canvas, w, h);
    ctx.clearRect(0, 0, w, h);
    var candles = (data && data.candles) || [];
    var padT = 8, padB = 36, padX = 2;
    if (!candles.length) {
      ctx.fillStyle = MUTED;
      ctx.font = "14px -apple-system, BlinkMacSystemFont, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("No candles yet", w / 2, h / 2);
      return;
    }
    var highs = candles.map(function (c) { return Number(c.high); });
    var lows = candles.map(function (c) { return Number(c.low); });
    var vols = candles.map(function (c) { return Number(c.volume) || 0; });
    if (opts.stop != null) { highs.push(Number(opts.stop)); lows.push(Number(opts.stop)); }
    if (opts.trail != null) { highs.push(Number(opts.trail)); lows.push(Number(opts.trail)); }
    var ext = niceRange(Math.min.apply(null, lows), Math.max.apply(null, highs));
    var min = ext.min, max = ext.max;
    var plotH = h - padT - padB;
    var volH = 28;
    var bodyH = plotH - volH - 6;
    function Y(v) { return padT + (1 - (v - min) / (max - min)) * bodyH; }
    var n = candles.length;
    var slot = (w - padX * 2) / n;
    var cw = Math.max(1, slot * 0.6);

    if (opts.trail != null) {
      ctx.save();
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = ORANGE;
      ctx.lineWidth = 1;
      var ty = Math.round(Y(Number(opts.trail))) + 0.5;
      ctx.beginPath(); ctx.moveTo(padX, ty); ctx.lineTo(w - padX, ty); ctx.stroke();
      ctx.restore();
    }
    if (opts.stop != null) {
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = RED;
      ctx.lineWidth = 1;
      var sy = Math.round(Y(Number(opts.stop))) + 0.5;
      ctx.beginPath(); ctx.moveTo(padX, sy); ctx.lineTo(w - padX, sy); ctx.stroke();
      ctx.restore();
    }

    var maxVol = Math.max.apply(null, vols.concat([1]));
    candles.forEach(function (c, i) {
      var x = padX + slot * i + slot / 2;
      var o = Number(c.open), cl = Number(c.close), hi = Number(c.high), lo = Number(c.low);
      var up = cl >= o;
      ctx.strokeStyle = ctx.fillStyle = up ? GREEN : RED;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, Y(hi));
      ctx.lineTo(x, Y(lo));
      ctx.stroke();
      var top = Y(Math.max(o, cl)), bot = Y(Math.min(o, cl));
      var bh = Math.max(1, bot - top);
      ctx.fillRect(x - cw / 2, top, cw, bh);
      var vh = (vols[i] / maxVol) * volH;
      ctx.globalAlpha = 0.55;
      ctx.fillRect(x - cw / 2, h - padB + 6 + (volH - vh), cw, vh);
      ctx.globalAlpha = 1;
    });
  }

  function drawScoreRing(canvas, score, minScore) {
    var box = canvas.parentElement.getBoundingClientRect();
    var size = Math.min(box.width || 88, box.height || 88, 96);
    var ctx = dpr(canvas, size, size);
    ctx.clearRect(0, 0, size, size);
    var cx = size / 2, cy = size / 2, r = size * 0.36, lw = size * 0.08;
    ctx.lineWidth = lw;
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(84,84,88,0.55)";
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    var s = Number(score);
    if (!isFinite(s)) return;
    var t = Math.max(0, Math.min(100, s)) / 100;
    var start = -Math.PI / 2;
    ctx.strokeStyle = s >= (minScore || 70) ? GREEN : "#ffd60a";
    ctx.beginPath();
    ctx.arc(cx, cy, r, start, start + t * Math.PI * 2, false);
    ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.font = "600 " + Math.round(size * 0.22) + "px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(Math.round(s)), cx, cy);
  }

  global.DeskCharts = { drawLineChart: drawLineChart, drawCandles: drawCandles, drawScoreRing: drawScoreRing };
})(window);
