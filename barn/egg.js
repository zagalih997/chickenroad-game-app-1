(function () {
    "use strict";

    var STORE_KEY = "eggBasket";
    var START_FEED = 1000;
    var NEST_COUNT = 9;
    var PEG_ROWS = 10;
    var P_MAX = 16;
    var WIDE_HOP_CHANCE = 0.4;
    var NEST_MULTS = [3.8, 0.9, 0.5, 0.3, 0.25, 0.3, 0.5, 0.9, 3.8];
    var MAX_EGGS_ALOFT = 5;
    var HOP_MS = 108;
    var FIRST_FALL_MS = 240;
    var TALLY_LIMIT = 12;
    var FEED_NUDGE = 5;
    var FEED_CAP = 100000;

    function grab(id) { return document.getElementById(id); }
    var canvas = grab("egg-board");
    var feedEl = grab("egg-balance");
    var refillBtn = grab("egg-refill");
    var betField = grab("egg-bet");
    var betDown = grab("egg-bet-down");
    var betUp = grab("egg-bet-up");
    var layBtn = grab("egg-lay");
    var callboard = grab("egg-status");
    var tallyEl = grab("egg-tally");
    if (!canvas || !canvas.getContext || !feedEl || !refillBtn ||
        !betField || !betDown || !betUp || !layBtn || !callboard ||
        !tallyEl) { return; }
    var ctx = canvas.getContext("2d");

    var feed = loadFeed();
    var eggs = [];
    var motes = [];
    var pegGlow = {};
    var nestGlow = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    var hen = { t: 0.22, dir: 1, pace: 0.00042, ms: 0 };
    var layout = null;
    var rafId = 0;
    var lastTs = 0;
    var inView = true;

    function loadFeed() {
        var raw = null;
        try { raw = window.localStorage.getItem(STORE_KEY); }
        catch (err) { raw = null; }
        if (raw === null || raw === "") { return START_FEED; }
        var n = Number(raw);
        return (isFinite(n) && n >= 0) ? round2(n) : START_FEED;
    }

    function saveFeed() {
        try { window.localStorage.setItem(STORE_KEY, String(feed)); }
        catch (err) { /* private mode: the round still plays */ }
    }

    function paintFeed() { feedEl.textContent = fmt(feed); }

    function round2(n) { return Math.round(n * 100) / 100; }

    function fmt(n) {
        var r = round2(n);
        return r === Math.floor(r) ? String(r) : r.toFixed(2);
    }

    function note(text, mood) {
        callboard.textContent = text;
        callboard.classList.remove("egg-cheer", "egg-groan");
        if (mood) { callboard.classList.add(mood); }
    }

    function readBet() {
        var v = Math.floor(Number(betField.value));
        return isFinite(v) ? v : 0;
    }

    function boundBet(v) {
        return Math.min(FEED_CAP, Math.max(1, v));
    }

    function clampBet() { betField.value = String(boundBet(readBet())); }

    function nudgeBet(step) {
        betField.value = String(boundBet(readBet() + step));
    }

    function measure() {
        var holder = canvas.parentNode;
        var pads = window.getComputedStyle(holder);
        var inner = holder.clientWidth -
            (parseFloat(pads.paddingLeft) || 0) -
            (parseFloat(pads.paddingRight) || 0);
        var cssW = Math.min(640, Math.max(240, inner));
        var cssH = Math.round(cssW * 1.04);
        var dpr = window.devicePixelRatio || 1;
        canvas.style.width = cssW + "px";
        canvas.style.height = cssH + "px";
        canvas.width = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        var pad = cssW * 0.035;
        var laneW = (cssW - pad * 2) / NEST_COUNT;
        var nestY = cssH * 0.845;
        var pegTop = cssH * 0.21;
        layout = {
            w: cssW, h: cssH, pad: pad, laneW: laneW,
            beamY: cssH * 0.075, pegTop: pegTop, nestY: nestY,
            rowGap: (nestY - pegTop) / PEG_ROWS,
            pegR: Math.max(3, laneW * 0.1),
            eggR: Math.max(4.5, laneW * 0.17)
        };
    }

    function laneX(P) { return layout.pad + (P + 1) * layout.laneW / 2; }

    function pegRowY(r) { return layout.pegTop + r * layout.rowGap; }

    function henX() {
        return laneX(0) + hen.t * (laneX(P_MAX) - laneX(0));
    }

    function forgePath(P0) {
        var path = [P0];
        var P = P0;
        for (var i = 0; i < PEG_ROWS; i += 1) {
            var hop = Math.random() < WIDE_HOP_CHANCE ? 3 : 1;
            var next = P + (Math.random() < 0.5 ? -hop : hop);
            if (next < 0) { next = -next; }
            if (next > P_MAX) { next = P_MAX * 2 - next; }
            path.push(next);
            P = next;
        }
        return path;
    }

    function segmentOf(egg) {
        var s = egg.seg;
        if (s < 0) {
            return {
                x0: egg.henFromX, y0: layout.beamY + layout.laneW * 0.34,
                x1: laneX(egg.path[0]), y1: pegRowY(0),
                ms: FIRST_FALL_MS, lift: 0
            };
        }
        var wide = Math.abs(egg.path[s + 1] - egg.path[s]) > 1;
        return {
            x0: laneX(egg.path[s]), y0: pegRowY(s),
            x1: laneX(egg.path[s + 1]),
            y1: s === PEG_ROWS - 1 ? layout.nestY : pegRowY(s + 1),
            ms: HOP_MS * (wide ? 1.35 : 1),
            lift: layout.rowGap * (wide ? 0.55 : 0.34)
        };
    }

    function advanceEgg(egg, dt) {
        var seg = segmentOf(egg);
        egg.t += dt / seg.ms;
        while (egg.t >= 1) {
            egg.t -= 1;
            egg.seg += 1;
            if (egg.seg >= PEG_ROWS) { settleEgg(egg); return; }
            pegGlow[egg.seg + ":" + egg.path[egg.seg]] = 1;
            egg.squash = 1;
            seg = segmentOf(egg);
            egg.t = Math.min(egg.t * (seg.ms / HOP_MS), 0.35);
        }
        var t = egg.t;
        var e = egg.seg < 0 ? t * t : t;
        egg.x = seg.x0 + (seg.x1 - seg.x0) * e;
        egg.y = seg.y0 + (seg.y1 - seg.y0) * e -
            seg.lift * Math.sin(Math.PI * t);
        egg.spin += dt * 0.004 * (seg.x1 >= seg.x0 ? 1 : -1);
        egg.squash = Math.max(0, egg.squash - dt / 140);
    }

    function settleEgg(egg) {
        egg.done = true;
        var nest = egg.path[PEG_ROWS] / 2;
        var mult = NEST_MULTS[nest];
        var winnings = round2(egg.stake * mult);
        feed = round2(feed + winnings);
        saveFeed();
        paintFeed();
        nestGlow[nest] = 1;
        var tier = mult >= 2 ? "gold" : (mult < 0.6 ? "crack" : "plain");
        burst(laneX(nest * 2), layout.nestY, tier);
        addTally(mult, winnings, tier);
        if (tier === "gold") {
            note("Golden nest! ×" + mult + " pays " + fmt(winnings) +
                " feed.", "egg-cheer");
        } else if (tier === "crack") {
            note("Splat — the ×" + mult + " nest cracked it. " +
                fmt(winnings) + " feed back.", "egg-groan");
        } else {
            note("Soft straw landing at ×" + mult + " — " +
                fmt(winnings) + " feed returned.", "");
        }
        if (feed < 1 && eggs.length <= 1) {
            note("The feed bag is empty — press Refill to keep " +
                "practising.", "egg-groan");
        }
    }

    function burst(x, y, tier) {
        var palette = tier === "gold"
            ? ["#f6c453", "#ffe9a8", "#e8a020"]
            : (tier === "crack"
                ? ["#f59e0b", "#fffdf5", "#fde68a"]
                : ["#d9a441", "#c98f2f", "#efd9a7"]);
        var count = tier === "plain" ? 8 : 16;
        for (var i = 0; i < count; i += 1) {
            motes.push({
                x: x, y: y - layout.laneW * 0.2,
                vx: (Math.random() - 0.5) * 0.14,
                vy: tier === "gold" ? -0.05 - Math.random() * 0.1
                    : -0.12 * Math.random(),
                g: tier === "gold" ? 0.00004 : 0.00035,
                life: 1, fade: 0.0012 + Math.random() * 0.0012,
                r: 1.6 + Math.random() * 2.2,
                hue: palette[i % palette.length]
            });
        }
    }

    function addTally(mult, winnings, tier) {
        var chip = document.createElement("li");
        chip.className = "egg-tally-chip egg-tally-" + tier;
        chip.textContent = "×" + mult;
        chip.setAttribute("title", "+" + fmt(winnings) + " feed");
        tallyEl.insertBefore(chip, tallyEl.firstChild);
        while (tallyEl.children.length > TALLY_LIMIT) {
            tallyEl.removeChild(tallyEl.lastChild);
        }
    }

    function blob(x, y, rx, ry, rot, fill, edge) {
        ctx.fillStyle = fill;
        ctx.beginPath();
        ctx.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2);
        ctx.fill();
        if (edge) {
            ctx.strokeStyle = edge;
            ctx.lineWidth = 1.4;
            ctx.stroke();
        }
    }

    function paint() {
        var L = layout;
        ctx.clearRect(0, 0, L.w, L.h);
        ctx.fillStyle = "#fdf3e3";
        ctx.fillRect(0, 0, L.w, L.h);
        ctx.fillStyle = "#8b5a2b";
        ctx.fillRect(0, L.beamY + L.laneW * 0.22, L.w, L.laneW * 0.18);
        ctx.fillStyle = "rgba(84, 51, 23, 0.35)";
        ctx.fillRect(0, L.beamY + L.laneW * 0.34, L.w, L.laneW * 0.06);
        var railTop = L.pegTop - L.rowGap * 0.6;
        var railH = L.nestY - railTop;
        ctx.fillStyle = "#b08050";
        ctx.fillRect(L.pad * 0.25, railTop, L.pad * 0.5, railH);
        ctx.fillRect(L.w - L.pad * 0.75, railTop, L.pad * 0.5, railH);
        for (var r = 0; r < PEG_ROWS; r += 1) {
            for (var P = r % 2; P <= P_MAX; P += 2) {
                drawPeg(laneX(P), pegRowY(r), pegGlow[r + ":" + P] || 0);
            }
        }
        for (var k = 0; k < NEST_COUNT; k += 1) { drawNest(k); }
        for (var i = 0; i < eggs.length; i += 1) { drawEgg(eggs[i]); }
        drawHen(henX(), L.beamY, hen.dir, hen.ms);
        drawMotes();
    }

    function drawPeg(x, y, glow) {
        var R = layout.pegR;
        if (glow > 0) {
            blob(x, y, R * 2.1, R * 2.1, 0,
                "rgba(246, 196, 83, " + (glow * 0.55) + ")");
        }
        blob(x, y, R, R, 0, "#a16632");
        blob(x + R * 0.22, y + R * 0.25, R * 0.62, R * 0.62, 0, "#7c4a1e");
        blob(x - R * 0.28, y - R * 0.3, R * 0.34, R * 0.34, 0, "#c98f4c");
    }

    function drawNest(k) {
        var L = layout;
        var x = laneX(k * 2);
        var y = L.nestY;
        var rx = L.laneW * 0.44;
        var gold = NEST_MULTS[k] >= 2;
        if (nestGlow[k] > 0) {
            blob(x, y, rx * 1.5, rx * 0.9, 0,
                "rgba(246, 196, 83, " + (nestGlow[k] * 0.4) + ")");
        }
        blob(x, y, rx, rx * 0.58, 0, gold ? "#e2b04f" : "#d9a441");
        blob(x, y + rx * 0.12, rx * 0.66, rx * 0.3, 0, "#a87420");
        ctx.strokeStyle = gold ? "#8a5a10" : "#96681c";
        ctx.lineWidth = 1;
        for (var i = -2; i <= 2; i += 1) {
            ctx.beginPath();
            ctx.moveTo(x + i * rx * 0.32 - rx * 0.18, y + rx * 0.42);
            ctx.lineTo(x + i * rx * 0.32 + rx * 0.18, y - rx * 0.1);
            ctx.stroke();
        }
        ctx.fillStyle = gold ? "#8a4d0b" : "#6d431f";
        ctx.font = "700 " + Math.max(10, L.laneW * 0.3) +
            "px Signika, Verdana, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("×" + NEST_MULTS[k], x, y + rx * 1.5);
    }

    function drawEgg(egg) {
        var R = layout.eggR;
        var sq = egg.squash * 0.25;
        ctx.save();
        ctx.translate(egg.x, egg.y);
        ctx.rotate(Math.sin(egg.spin) * 0.35);
        ctx.scale(1 + sq, 1 - sq);
        blob(0, 0, R * 0.8, R, 0, "#fffdf5", "rgba(139, 90, 43, 0.45)");
        blob(-R * 0.24, -R * 0.32, R * 0.22, R * 0.3, 0.4,
            "rgba(255, 255, 255, 0.9)");
        ctx.restore();
    }

    function drawHen(x, baseY, dir, ms) {
        var s = layout.laneW * 0.4;
        var line = "rgba(109, 67, 31, 0.5)";
        ctx.save();
        ctx.translate(x, baseY - s * 0.62);
        if (dir < 0) { ctx.scale(-1, 1); }
        ctx.translate(0, Math.sin(ms * 0.013) * s * 0.07);
        var swing = Math.sin(ms * 0.021) * s * 0.3;
        ctx.strokeStyle = "#d97706";
        ctx.lineWidth = Math.max(1.4, s * 0.12);
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(-s * 0.28, s * 0.5);
        ctx.lineTo(-s * 0.28 + swing, s * 0.92);
        ctx.moveTo(s * 0.12, s * 0.5);
        ctx.lineTo(s * 0.12 - swing, s * 0.92);
        ctx.stroke();
        blob(-s * 0.95, -s * 0.34, s * 0.42, s * 0.6, 0.7, "#e8d9bd");
        blob(-s * 0.08, 0, s * 1.02, s * 0.72, -0.08, "#f6ecd8", line);
        blob(-s * 0.18, s * 0.05, s * 0.5, s * 0.34, 0.35, "#e3d0ac");
        blob(s * 0.78, -s * 0.62, s * 0.4, s * 0.4, 0, "#f6ecd8", line);
        blob(s * 0.62, -s * 0.99, s * 0.13, s * 0.13, 0, "#c62828");
        blob(s * 0.8, -s * 1.06, s * 0.15, s * 0.15, 0, "#c62828");
        blob(s * 0.97, -s * 0.97, s * 0.12, s * 0.12, 0, "#c62828");
        blob(s * 1.12, -s * 0.42, s * 0.11, s * 0.11, 0, "#c62828");
        ctx.fillStyle = "#ea9d1f";
        ctx.beginPath();
        ctx.moveTo(s * 1.14, -s * 0.66);
        ctx.lineTo(s * 1.44, -s * 0.56);
        ctx.lineTo(s * 1.14, -s * 0.46);
        ctx.closePath();
        ctx.fill();
        blob(s * 0.86, -s * 0.68, s * 0.06, s * 0.06, 0, "#43302b");
        ctx.restore();
    }

    function drawMotes() {
        for (var i = 0; i < motes.length; i += 1) {
            var m = motes[i];
            ctx.globalAlpha = Math.max(0, m.life);
            blob(m.x, m.y, m.r, m.r, 0, m.hue);
        }
        ctx.globalAlpha = 1;
    }

    function step(dt) {
        hen.ms += dt;
        hen.t += hen.dir * hen.pace * dt;
        if (hen.t > 1) { hen.t = 1; hen.dir = -1; }
        if (hen.t < 0) { hen.t = 0; hen.dir = 1; }
        for (var i = eggs.length - 1; i >= 0; i -= 1) {
            advanceEgg(eggs[i], dt);
            if (eggs[i].done) {
                eggs.splice(i, 1);
                refreshButtons();
            }
        }
        var key;
        for (key in pegGlow) {
            if (Object.prototype.hasOwnProperty.call(pegGlow, key)) {
                pegGlow[key] -= dt / 320;
                if (pegGlow[key] <= 0) { delete pegGlow[key]; }
            }
        }
        for (var k = 0; k < NEST_COUNT; k += 1) {
            if (nestGlow[k] > 0) {
                nestGlow[k] = Math.max(0, nestGlow[k] - dt / 650);
            }
        }
        for (var j = motes.length - 1; j >= 0; j -= 1) {
            var m = motes[j];
            m.vy += m.g * dt;
            m.x += m.vx * dt;
            m.y += m.vy * dt;
            m.life -= m.fade * dt;
            if (m.life <= 0) { motes.splice(j, 1); }
        }
    }

    function frame(ts) {
        rafId = 0;
        var dt = lastTs ? Math.min(48, ts - lastTs) : 16;
        lastTs = ts;
        step(dt);
        paint();
        if (inView || eggs.length > 0 || motes.length > 0) {
            rafId = window.requestAnimationFrame(frame);
        } else {
            lastTs = 0;
        }
    }

    function wake() {
        if (!rafId) {
            lastTs = 0;
            rafId = window.requestAnimationFrame(frame);
        }
    }

    function dropEgg() {
        clampBet();
        var stake = readBet();
        if (stake < 1) {
            note("Feed at least 1 credit per egg.", "egg-groan");
            return;
        }
        if (stake > feed) {
            note("Not enough feed credits for that stake.", "egg-groan");
            return;
        }
        if (eggs.length >= MAX_EGGS_ALOFT) {
            note("The chute is full — let an egg land first.", "egg-groan");
            return;
        }
        feed = round2(feed - stake);
        saveFeed();
        paintFeed();
        var startX = henX();
        var P0 = Math.round((startX - laneX(0)) / layout.laneW) * 2;
        P0 = Math.min(P_MAX, Math.max(0, P0));
        eggs.push({
            stake: stake, path: forgePath(P0), seg: -1, t: 0,
            henFromX: startX, x: startX,
            y: layout.beamY + layout.laneW * 0.34,
            spin: 0, squash: 0, done: false
        });
        note("Egg away over lane " + (P0 / 2 + 1) + "…", "");
        refreshButtons();
        wake();
    }

    function refillFeed() {
        if (eggs.length > 0) { return; }
        feed = START_FEED;
        saveFeed();
        paintFeed();
        note("Feed bag topped back up to " + START_FEED + ".", "");
    }

    function refreshButtons() {
        layBtn.disabled = eggs.length >= MAX_EGGS_ALOFT;
        refillBtn.disabled = eggs.length > 0;
    }

    layBtn.addEventListener("click", dropEgg);
    refillBtn.addEventListener("click", refillFeed);
    betDown.addEventListener("click", function () { nudgeBet(-FEED_NUDGE); });
    betUp.addEventListener("click", function () { nudgeBet(FEED_NUDGE); });
    betField.addEventListener("change", clampBet);
    window.addEventListener("resize", function () {
        measure();
        if (!rafId) { paint(); }
    });
    if ("IntersectionObserver" in window) {
        var io = new IntersectionObserver(function (entries) {
            inView = entries[0].isIntersecting;
            if (inView) { wake(); }
        }, { threshold: 0.02 });
        io.observe(canvas);
    }

    measure();
    paintFeed();
    refreshButtons();
    paint();
    wake();
    if (feed < 1) {
        note("The feed bag is empty — press Refill to start.", "");
    }
})();
