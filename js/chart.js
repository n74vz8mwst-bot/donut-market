/* ==========================================================================
   DONUT MARKET — chart.js
   A dependency-free candlestick / area chart on a canvas.

   Written by hand rather than pulled from a library for two reasons: it can
   read the page's own CSS tokens, so it re-colours instantly when the theme
   flips, and it can lay out the x-axis the way trading charts actually do —
   by bar index, not by clock time. Index spacing is what removes the dead
   space over nights and weekends: a market that was shut for 64 hours takes
   up no width at all, and the gap shows as a jump between candles.
   ========================================================================== */

const DM_CHART = (() => {
  const PAD = { top: 10, right: 62, bottom: 22, left: 6 };
  const VOLUME_SHARE = 0.2; // fraction of the plot given to volume bars

  function niceStep(range, targetLines) {
    const raw = range / targetLines;
    const mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
    const norm = raw / mag;
    const step = norm >= 5 ? 5 : norm >= 2 ? 2 : 1;
    return step * mag;
  }

  function create(canvas, options = {}) {
    const ctx = canvas.getContext('2d');
    const wrap = canvas.parentElement;
    if (getComputedStyle(wrap).position === 'static') wrap.style.position = 'relative';

    const tooltip = document.createElement('div');
    tooltip.className = 'chart-tooltip';
    wrap.appendChild(tooltip);

    const state = {
      candles: [],
      type: options.type || 'candles',
      prevClose: options.prevClose || null,
      showVolume: options.showVolume !== false,
      hover: null,
      width: 0,
      height: 0,
      geom: null,
      valueFormat: options.valueFormat || ((v) => v.toFixed(2)),
    };

    /* ------------------------------------------------------------- sizing */

    function resize() {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      state.width = rect.width;
      state.height = rect.height;
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw();
    }

    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    /* -------------------------------------------------------------- colors */

    function palette() {
      return {
        up: DM.token('--up') || '#2fd6a0',
        down: DM.token('--down') || '#ff5c6c',
        ink: DM.token('--ink') || '#fff',
        ink3: DM.token('--ink-3') || 'rgba(255,255,255,0.5)',
        ink4: DM.token('--ink-4') || 'rgba(255,255,255,0.3)',
        border: DM.token('--border') || 'rgba(255,255,255,0.08)',
        surface: DM.token('--surface') || '#14121f',
        glaze: DM.token('--glaze') || '#ff5fa8',
      };
    }

    /* --------------------------------------------------------------- draw */

    function draw() {
      const { width: W, height: H, candles } = state;
      if (!W || !H) return;

      ctx.clearRect(0, 0, W, H);
      const c = palette();

      if (!candles.length) {
        ctx.fillStyle = c.ink4;
        ctx.font = '13px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('No price history yet.', W / 2, H / 2);
        state.geom = null;
        return;
      }

      const plotW = W - PAD.left - PAD.right;
      const plotH = H - PAD.top - PAD.bottom;
      const volH = state.showVolume ? plotH * VOLUME_SHARE : 0;
      const priceH = plotH - volH - (state.showVolume ? 8 : 0);

      // Price scale, padded so the extremes aren't glued to the frame.
      let lo = Math.min(...candles.map((k) => k.l));
      let hi = Math.max(...candles.map((k) => k.h));
      if (state.prevClose) { lo = Math.min(lo, state.prevClose); hi = Math.max(hi, state.prevClose); }
      const span = hi - lo || Math.max(hi * 0.01, 0.02);
      lo -= span * 0.08;
      hi += span * 0.08;

      const x = (i) => PAD.left + (candles.length === 1 ? plotW / 2 : (i / (candles.length - 1)) * plotW);
      const y = (v) => PAD.top + priceH - ((v - lo) / (hi - lo)) * priceH;
      const maxVol = Math.max(...candles.map((k) => k.v || 0), 1);
      const vy = (v) => PAD.top + priceH + 8 + volH - (v / maxVol) * volH;

      state.geom = { x, y, plotW, priceH, volH, lo, hi };

      // --- horizontal grid + price axis ---
      const step = niceStep(hi - lo, 5);
      ctx.font = '11px "JetBrains Mono", monospace';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
        const py = y(v);
        ctx.strokeStyle = c.border;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(PAD.left, Math.round(py) + 0.5);
        ctx.lineTo(W - PAD.right, Math.round(py) + 0.5);
        ctx.stroke();
        ctx.fillStyle = c.ink4;
        ctx.fillText(state.valueFormat(v), W - PAD.right + 8, py);
      }

      // --- previous close reference ---
      if (state.prevClose) {
        const py = y(state.prevClose);
        ctx.save();
        ctx.setLineDash([3, 4]);
        ctx.strokeStyle = c.ink4;
        ctx.beginPath();
        ctx.moveTo(PAD.left, py);
        ctx.lineTo(W - PAD.right, py);
        ctx.stroke();
        ctx.restore();
      }

      // --- time axis: a label wherever the day changes, plus a few in between ---
      ctx.textAlign = 'center';
      ctx.fillStyle = c.ink4;
      const labelEvery = Math.max(1, Math.round(candles.length / 6));
      let lastDay = null;
      candles.forEach((k, i) => {
        const d = new Date(k.t);
        const dayKey = d.toDateString();
        const isNewDay = lastDay !== null && dayKey !== lastDay;
        if (i % labelEvery === 0 || isNewDay) {
          const label = isNewDay || candles.length > 200
            ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
            : d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
          ctx.fillText(label, x(i), H - PAD.bottom / 2);
          if (isNewDay) {
            ctx.save();
            ctx.strokeStyle = c.border;
            ctx.setLineDash([2, 3]);
            ctx.beginPath();
            ctx.moveTo(x(i), PAD.top);
            ctx.lineTo(x(i), PAD.top + priceH);
            ctx.stroke();
            ctx.restore();
          }
        }
        lastDay = dayKey;
      });

      // --- volume ---
      if (state.showVolume) {
        const barW = Math.max(1, (plotW / candles.length) * 0.62);
        candles.forEach((k, i) => {
          const rising = k.c >= k.o;
          ctx.fillStyle = rising ? c.up : c.down;
          ctx.globalAlpha = 0.28;
          const top = vy(k.v || 0);
          ctx.fillRect(x(i) - barW / 2, top, barW, PAD.top + priceH + 8 + volH - top);
        });
        ctx.globalAlpha = 1;
      }

      // --- price series ---
      if (state.type === 'area') drawArea(c, x, y, candles);
      else drawCandles(c, x, y, candles, plotW);

      // --- last price tag ---
      const last = candles[candles.length - 1];
      const rising = state.prevClose ? last.c >= state.prevClose : last.c >= candles[0].o;
      const ly = y(last.c);
      ctx.fillStyle = rising ? c.up : c.down;
      ctx.fillRect(W - PAD.right + 2, ly - 9, PAD.right - 6, 18);
      ctx.fillStyle = c.surface;
      ctx.font = '600 11px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText(state.valueFormat(last.c), W - PAD.right + 2 + (PAD.right - 6) / 2, ly);

      if (state.hover != null) drawCrosshair(c, x, y, candles, W, H, priceH, volH);
    }

    function drawArea(c, x, y, candles) {
      const rising = candles[candles.length - 1].c >= candles[0].o;
      const color = rising ? c.up : c.down;
      const grad = ctx.createLinearGradient(0, PAD.top, 0, PAD.top + state.geom.priceH);
      grad.addColorStop(0, hexToRgba(color, 0.26));
      grad.addColorStop(1, hexToRgba(color, 0));

      ctx.beginPath();
      candles.forEach((k, i) => (i === 0 ? ctx.moveTo(x(i), y(k.c)) : ctx.lineTo(x(i), y(k.c))));
      const bottom = PAD.top + state.geom.priceH;
      ctx.lineTo(x(candles.length - 1), bottom);
      ctx.lineTo(x(0), bottom);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();

      ctx.beginPath();
      candles.forEach((k, i) => (i === 0 ? ctx.moveTo(x(i), y(k.c)) : ctx.lineTo(x(i), y(k.c))));
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.stroke();
    }

    function drawCandles(c, x, y, candles, plotW) {
      const slot = plotW / candles.length;
      const bodyW = Math.max(1, Math.min(14, slot * 0.66));
      candles.forEach((k, i) => {
        const rising = k.c >= k.o;
        const color = rising ? c.up : c.down;
        const cx = x(i);

        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(cx) + 0.5, y(k.h));
        ctx.lineTo(Math.round(cx) + 0.5, y(k.l));
        ctx.stroke();

        const top = y(Math.max(k.o, k.c));
        const height = Math.max(1, Math.abs(y(k.o) - y(k.c)));
        ctx.fillStyle = color;
        ctx.fillRect(cx - bodyW / 2, top, bodyW, height);
      });
    }

    function drawCrosshair(c, x, y, candles, W, H, priceH, volH) {
      const i = state.hover;
      const k = candles[i];
      if (!k) return;

      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = c.ink3;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x(i), PAD.top);
      ctx.lineTo(x(i), PAD.top + priceH + 8 + volH);
      ctx.stroke();
      ctx.restore();

      tooltip.innerHTML = `
        <div class="row"><span class="k">${new Date(k.t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span></div>
        <div class="row"><span class="k">O</span><span>${state.valueFormat(k.o)}</span></div>
        <div class="row"><span class="k">H</span><span>${state.valueFormat(k.h)}</span></div>
        <div class="row"><span class="k">L</span><span>${state.valueFormat(k.l)}</span></div>
        <div class="row"><span class="k">C</span><span>${state.valueFormat(k.c)}</span></div>
        ${k.v != null ? `<div class="row"><span class="k">Vol</span><span>${DM.qty(k.v)}</span></div>` : ''}`;
      tooltip.classList.add('show');

      const tw = tooltip.offsetWidth;
      const px = x(i) + 14 + tw > W ? x(i) - 14 - tw : x(i) + 14;
      tooltip.style.left = `${Math.max(4, px)}px`;
      tooltip.style.top = `${Math.max(4, Math.min(y(k.c) - 30, H - tooltip.offsetHeight - 6))}px`;
    }

    function hexToRgba(color, alpha) {
      const hex = color.trim();
      if (hex.startsWith('#')) {
        const full = hex.length === 4 ? hex.replace(/#(.)(.)(.)/, '#$1$1$2$2$3$3') : hex;
        const n = parseInt(full.slice(1), 16);
        return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
      }
      return hex;
    }

    /* ------------------------------------------------------------- pointer */

    function onMove(event) {
      if (!state.geom || !state.candles.length) return;
      const rect = canvas.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const ratio = (px - PAD.left) / state.geom.plotW;
      const index = Math.round(ratio * (state.candles.length - 1));
      const clamped = Math.max(0, Math.min(state.candles.length - 1, index));
      if (clamped !== state.hover) {
        state.hover = clamped;
        draw();
      }
    }

    function onLeave() {
      state.hover = null;
      tooltip.classList.remove('show');
      draw();
    }

    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mouseleave', onLeave);
    canvas.addEventListener('touchmove', (e) => {
      if (e.touches[0]) onMove(e.touches[0]);
    }, { passive: true });
    canvas.addEventListener('touchend', onLeave);

    const onTheme = () => draw();
    document.addEventListener('dm:theme', onTheme);

    resize();

    return {
      setData(candles, prevClose) {
        state.candles = (candles || []).filter((k) => Number.isFinite(k.c));
        if (prevClose !== undefined) state.prevClose = prevClose;
        draw();
      },
      setType(type) {
        state.type = type;
        draw();
      },
      setPrevClose(value) {
        state.prevClose = value;
        draw();
      },
      redraw: draw,
      destroy() {
        ro.disconnect();
        document.removeEventListener('dm:theme', onTheme);
        canvas.removeEventListener('mousemove', onMove);
        canvas.removeEventListener('mouseleave', onLeave);
        tooltip.remove();
      },
    };
  }

  return { create };
})();

window.DM_CHART = DM_CHART;
