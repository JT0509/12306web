/* 12306 购票助手 - 前端交互逻辑 */
/* global fetch, localStorage, AbortController, setTimeout, clearTimeout */

(function() {
    'use strict';

    var API = 'http://127.0.0.1:8765';
    var HK = 'train_query_history';
    var MAXH = 5;
    var sCtrl = null, pCtrl = null, dCtrl = null;

    var $ = function(s) { return document.querySelector(s); };
    var $$ = function(s) { return document.querySelectorAll(s); };

    var fInp = $('#fromInput'), tInp = $('#toInput'), dInp = $('#dateInput');
    var sBtn = $('#searchBtn'), cBtn = $('#cancelBtn'), swBtn = $('#swapBtn');
    var stat = $('#statusBar'), res = $('#results'), filt = $('#filterRow');
    var fSug = $('#fromSuggestions'), tSug = $('#toSuggestions');

    function init() {
        var tm = new Date(); tm.setDate(tm.getDate() + 1);
        var ds = tm.toISOString().split('T')[0];
        dInp.min = ds; dInp.value = ds;
        loadH(); bind();
    }

    function bind() {
        sBtn.addEventListener('click', doS);
        cBtn.addEventListener('click', cancel);
        swBtn.addEventListener('click', swap);
        fInp.addEventListener('input', deb(function() { sug(fInp, fSug); }, 250));
        tInp.addEventListener('input', deb(function() { sug(tInp, tSug); }, 250));
        document.addEventListener('click', closeS);
        $$('input[name="sort"]').forEach(function(r) {
            r.addEventListener('change', function() { if (res.children.length) doS(); });
        });
        $$('.filter-btn').forEach(function(b) {
            b.addEventListener('click', function() {
                $$('.filter-btn').forEach(function(x) { x.classList.remove('active'); });
                this.classList.add('active'); applyF(this.dataset.filter);
            });
        });
    }

    function cancel() {
        if (sCtrl) { sCtrl.abort(); sCtrl = null; }
        if (pCtrl) { pCtrl.abort(); pCtrl = null; }
        if (dCtrl) { dCtrl.abort(); dCtrl = null; }
        setL(false); statMsg('已取消', 'warning');
    }

    async function sug(input, list) {
        var q = input.value.trim();
        if (q.length < 1) { list.classList.remove('show'); return; }
        try {
            var r = await fetch(API + '/api/stations?q=' + encodeURIComponent(q));
            var d = await r.json();
            renderS(list, d.stations || [], input);
        } catch (e) {}
    }

    function renderS(el, stations, input) {
        el.innerHTML = '';
        if (!stations.length) { el.classList.remove('show'); return; }
        stations.forEach(function(s) {
            var li = document.createElement('li'); li.textContent = s;
            li.addEventListener('mousedown', function() { input.value = s; el.classList.remove('show'); });
            el.appendChild(li);
        });
        el.classList.add('show');
    }

    function closeS(e) { if (!e.target.closest('.input-group')) { fSug.classList.remove('show'); tSug.classList.remove('show'); } }
    function swap() { var t = fInp.value; fInp.value = tInp.value; tInp.value = t; swap2(); }

    function swap2() {
        var tmp = fInp.value; fInp.value = tInp.value; tInp.value = tmp;
    }

    function valInp() {
        var ok = true;
        [fInp, tInp].forEach(function(inp) {
            inp.classList.remove('error');
            if (!inp.value.trim()) { inp.classList.add('error'); ok = false; }
        });
        return ok;
    }

    // ===== 搜索（直达优先，中转后台） =====
    async function doS() {
        if (!valInp()) { statMsg('请填写出发站和到达站', 'error'); return; }
        cancel();

        var from = fInp.value.trim(), to = tInp.value.trim(), date = dInp.value;
        var sortBy = (document.querySelector('input[name="sort"]:checked') || {}).value || 'price';

        setL(true); statMsg('正在查询直达车次... <small>(可点取消)</small>', 'loading');
        res.innerHTML = skel(3);
        saveH({ from: from, to: to, date: date });

        // 第一阶段：直达（快，~2秒）
        sCtrl = new AbortController();
        var dirData;
        try {
            var r1 = await fetch(API + '/api/search', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ from: from, to: to, date: date, sort_by: sortBy, type: 'direct' }),
                signal: sCtrl.signal,
            });
            dirData = await r1.json();
            if (!r1.ok) { statMsg(dirData.error || '查询失败', 'error'); res.innerHTML = ''; setL(false); return; }
        } catch (e) {
            if (e.name === 'AbortError') { setL(false); return; }
            statMsg('网络连接失败，请检查后端', 'error'); res.innerHTML = ''; setL(false); return;
        }
        sCtrl = null;
        setL(false);

        renderResults({ direct: dirData.direct || [], transfers: [] });
        var hasDir = dirData.direct && dirData.direct.length > 0;

        if (hasDir) {
            statMsg('找到 ' + dirData.direct.length + ' 趟直达 | 正在获取票价...', 'success');
            fetchP(dirData.direct, date);
        } else {
            statMsg('未找到直达车次，正在搜索中转方案...', 'loading');
        }

        // 第二阶段：中转（后台，慢~5s）
        var trCtrl = new AbortController();
        var trData;
        try {
            var r2 = await fetch(API + '/api/search', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ from: from, to: to, date: date, sort_by: sortBy, type: 'transfer' }),
                signal: trCtrl.signal,
            });
            trData = await r2.json();
        } catch (e) { trData = { transfers: [] }; }

        if (trData && trData.transfers && trData.transfers.length > 0) {
            res.appendChild(sectT('中转方案', trData.transfers.length, 'transfer'));
            trData.transfers.forEach(function(t) { res.appendChild(trCard(t)); });
            var tot = (dirData.direct || []).length + trData.transfers.length;
            statMsg('共 ' + tot + ' 个方案（' + dirData.direct.length + ' 直达 + ' + trData.transfers.length + ' 中转）', 'success');
        } else if (!hasDir) {
            res.innerHTML = '<div class="empty-state"><div class="empty-icon">🔍</div><p>暂无车次，请尝试其他日期或线路</p></div>';
            statMsg('未找到车次', 'warning');
        }

        filt.style.display = (hasDir && trData && trData.transfers && trData.transfers.length > 0) ? 'flex' : 'none';
        $$('.filter-btn').forEach(function(b) { b.classList.toggle('active', b.dataset.filter === 'all'); });
    }

    // ===== 异步价格 =====
    async function fetchP(trains, date) {
        if (!trains.length) return;
        pCtrl = new AbortController();
        var payload = trains.map(function(t) {
            return { train_no: t.train_no, internal_no: t.internal_no, from_no: String(t.from_no || ''), to_no: String(t.to_no || ''), seat_types: t.seat_types || '' };
        });
        try {
            var r = await fetch(API + '/api/price', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trains: payload, date: date }), signal: pCtrl.signal });
            var d = await r.json(); var pm = d.prices || {};
            trains.forEach(function(train) {
                var prices = pm[train.train_no] || {};
                var card = document.querySelector('.train-card[data-train-no="' + cssEsc(train.train_no) + '"]');
                if (!card) return;
                var sl = card.querySelector('.seat-list'); if (!sl) return;
                var h = '';
                train.seats.forEach(function(s) {
                    var p = prices[s.type];
                    var pt = (p !== undefined && p > 0) ? '<span class="seat-price">¥' + p + '</span>' : '<span class="seat-price" style="color:var(--text-secondary);">—</span>';
                    h += '<div class="seat-item"><span class="seat-type">' + esc(s.type) + '</span>' + pt + '</div>';
                });
                sl.innerHTML = h || '<span style="font-size:12px;color:var(--text-secondary);">暂无可选席别</span>';
            });
            updateBB();
            statMsg('票价加载完成', 'success');
        } catch (e) { if (e.name === 'AbortError') return; }
        pCtrl = null;
    }

    function updateBB() {
        var cards = $$('.train-card'), bp = Infinity, bn = '';
        cards.forEach(function(card) {
            card.querySelectorAll('.seat-price').forEach(function(el) {
                var v = parseFloat(el.textContent.replace('¥', ''));
                if (v > 0 && v < bp) { bp = v; bn = card.dataset.trainNo; }
            });
        });
        cards.forEach(function(card) {
            var old = card.querySelector('.badge.best-price'); if (old) old.remove();
            if (card.dataset.trainNo === bn && bp < Infinity) {
                var hd = card.querySelector('.card-header');
                if (hd) hd.insertAdjacentHTML('afterbegin', '<span class="badge best-price">💡 最实惠</span>');
            }
        });
    }

    // ===== 渲染 =====
    function renderResults(data) {
        res.innerHTML = '';
        if (data.direct.length) {
            res.appendChild(sectT('直达车次', data.direct.length, 'direct'));
            data.direct.forEach(function(t, i, a) { res.appendChild(tCard(t, i, a)); });
        }
    }

    function sectT(text, count, type) {
        var d = document.createElement('div'); d.className = 'section-title'; d.dataset.type = type;
        d.innerHTML = '📌 ' + text + ' <span class="count">(' + count + '个)</span>'; return d;
    }

    function tCard(train, idx, arr) {
        var card = document.createElement('div'); card.className = 'train-card'; card.dataset.type = 'direct'; card.dataset.trainNo = train.train_no;
        var minD = Math.min.apply(null, arr.map(durM)); var thisD = durM(train);
        var badges = thisD > 0 && thisD === minD ? '<span class="badge best-time">⚡ 最快</span>' : '';
        var seatsHtml = train.seats.map(function(s) {
            return '<div class="seat-item"><span class="seat-type">' + esc(s.type) + '</span><span class="seat-price" style="color:var(--text-secondary);">加载中...</span></div>';
        }).join('');
        card.dataset.internalNo = train.internal_no || ''; card.dataset.fromCode = train.from_code || ''; card.dataset.toCode = train.to_code || '';
        card.dataset.secretStr = train.secret_str || '';
        card.innerHTML =
            '<div class="card-header">' + badges +
                '<span class="train-code">' + esc(train.train_no) + '</span>' +
                '<span class="card-route">' + esc(train.from_station) + ' <span class="arrow">→</span> ' + esc(train.to_station) + '</span>' +
                '<span class="card-time">' + esc(train.depart_time) + ' - ' + esc(train.arrive_time) + '</span>' +
                '<span style="color:var(--text-secondary);font-size:13px;">' + esc(train.duration) + '</span>' +
            '</div><div class="seat-list">' + (seatsHtml || '<span style="font-size:12px;">—</span>') + '</div>' +
            '<div class="card-actions">' +
                '<button class="btn btn-detail">📋 查看详情</button>' +
                '<button class="btn btn-buy">🔗 去官网购买</button>' +
            '</div><div class="card-detail"></div>';
        card.querySelector('.btn-detail').addEventListener('click', function(e) { togDet(e, card, train); });
        card.querySelector('.btn-buy').addEventListener('click', function(e) { openBuy(e, train); });
        return card;
    }

    function trCard(t) {
        var card = document.createElement('div'); card.className = 'transfer-card'; card.dataset.type = 'transfer';
        var segHtml = t.segments.map(function(s) {
            return '<div class="transfer-segment"><span style="font-weight:600;">' + esc(s.train_no) + '</span> ' +
                esc(s.from_station) + ' → ' + esc(s.to_station) +
                ' <span style="color:var(--text-secondary);">' + esc(s.depart_time) + ' - ' + esc(s.arrive_time) + ' (' + esc(s.duration) + ')</span></div>';
        }).join('') + '<div class="transfer-wait">⏳ 换乘 ' + esc(t.transfer_time) + '</div>';
        var match = (t.transfer_time || '').match(/(\d+)h(\d+)m/);
        var short = match && (parseInt(match[1]) * 60 + parseInt(match[2])) < 30;
        card.innerHTML =
            '<div class="transfer-header">🔄 经 <b>' + esc(t.transfer_station) + '</b> 中转 ' +
                '<span>总价: <b style="color:var(--danger);">¥' + t.total_price + '</b></span> ' +
                '<span style="' + (short ? 'color:var(--danger);' : '') + '">总耗时: ' + esc(t.total_duration) + '</span></div>' +
            segHtml +
            '<div class="card-actions" style="padding-top:8px;">' +
                '<button class="btn btn-buy">🔗 分段购票（去官网）</button></div>' +
            '<div class="card-detail"></div>';
        card.querySelector('.btn-buy').addEventListener('click', function(e) {
            openBuy(e, { buy_link: 'https://kyfw.12306.cn/otn/leftTicket/init' });
        });
        return card;
    }

    // ===== 详情（可取消） =====
    async function togDet(e, card, train) {
        var det = card.querySelector('.card-detail'); if (!det) return;
        if (det.classList.contains('show')) { det.classList.remove('show'); if (dCtrl) { dCtrl.abort(); dCtrl = null; } return; }
        if (dCtrl) { dCtrl.abort(); }
        dCtrl = new AbortController();
        det.innerHTML = '<div class="skeleton-line" style="width:80%;"></div><div class="skeleton-line" style="width:60%;"></div>' +
            '<button class="btn btn-detail" style="margin-top:8px;font-size:11px;" id="detCancel">✕ 取消</button>';
        det.classList.add('show');
        det.querySelector('#detCancel').addEventListener('click', function() { det.classList.remove('show'); if (dCtrl) { dCtrl.abort(); dCtrl = null; } });

        var date = dInp.value;
        var url = API + '/api/train/' + encodeURIComponent(train.train_no) + '?date=' + encodeURIComponent(date);
        var ino = train.internal_no || card.dataset.internalNo || '';
        if (ino) url += '&internal_no=' + encodeURIComponent(ino) + '&from_code=' + encodeURIComponent(train.from_code || card.dataset.fromCode || '') + '&to_code=' + encodeURIComponent(train.to_code || card.dataset.toCode || '');

        try {
            var r = await fetch(url, { signal: dCtrl.signal });
            if (!r.ok) { det.innerHTML = '<p style="color:var(--danger);font-size:13px;padding:8px;">详情加载失败</p>'; return; }
            var data = await r.json();
            det.innerHTML = '<div class="route-timeline">' + data.route.map(function(s) {
                return '<div class="route-stop"><div class="station-name">' + esc(s.station) + '</div><div class="station-time">到 ' + esc(s.arrive) + ' 发 ' + esc(s.depart) + '</div></div>';
            }).join('') + '</div>';
        } catch (e) { if (e.name === 'AbortError') { det.innerHTML = ''; det.classList.remove('show'); return; } det.innerHTML = '<p style="color:var(--danger);font-size:13px;padding:8px;">详情加载失败</p>'; }
        dCtrl = null;
    }

    // ===== 购买跳转 =====
    function openBuy(e, train) {
        e.stopPropagation();
        var link = train.buy_link || 'https://kyfw.12306.cn/otn/leftTicket/init';
        try { var u = new URL(link); if (u.hostname.indexOf('12306.cn') === -1) { statMsg('链接无效', 'error'); return; } } catch (er) { statMsg('链接无效', 'error'); return; }
        window.open(link, '_blank', 'noopener');
        statMsg('已打开 12306 查询页（已预填出发/到达/日期），在列表中找到 <b>' + esc(train.train_no) + '</b> 点击"预订"即可购票', 'success');
    }

    function applyF(filter) {
        $$('.train-card, .transfer-card, .section-title').forEach(function(el) {
            if (filter === 'all') { el.style.display = ''; return; }
            el.style.display = (el.dataset.type === filter) ? '' : 'none';
        });
    }

    function skel(n) { return Array(n).fill(0).map(function() { return '<div class="skeleton"><div class="skeleton-line" style="width:40%;"></div><div class="skeleton-line" style="width:70%;"></div><div class="skeleton-line"></div></div>'; }).join(''); }
    function statMsg(msg, type) { stat.innerHTML = '<div class="status-msg ' + type + '">' + msg + '</div>'; }
    function setL(on) { sBtn.style.display = on ? 'none' : ''; cBtn.style.display = on ? '' : 'none'; sBtn.disabled = on; fInp.disabled = on; tInp.disabled = on; dInp.disabled = on; }

    function saveH(q) {
        try { var h = JSON.parse(localStorage.getItem(HK) || '[]'); h = h.filter(function(x) { return !(x.from === q.from && x.to === q.to); }); h.unshift(q); localStorage.setItem(HK, JSON.stringify(h.slice(0, MAXH))); loadH(); } catch (e) {}
    }

    function loadH() {
        try {
            var h = JSON.parse(localStorage.getItem(HK) || '[]');
            var bar = $('.history-bar'); if (!bar) { bar = document.createElement('div'); bar.className = 'history-bar'; $('#searchPanel').insertBefore(bar, $('.search-row')); }
            bar.innerHTML = h.length ? '<span style="font-size:12px;color:var(--text-secondary);">最近查询:</span>' : '';
            h.forEach(function(q) {
                var tag = document.createElement('span'); tag.className = 'history-tag'; tag.textContent = q.from + '→' + q.to;
                tag.addEventListener('click', function() { fInp.value = q.from; tInp.value = q.to; dInp.value = q.date; doS(); });
                bar.appendChild(tag);
            });
        } catch (e) {}
    }

    function esc(s) { if (!s) return ''; var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
    function cssEsc(s) { return s.replace(/[^a-zA-Z0-9_-]/g, '\\$&'); }
    function durM(t) { var m = (t.duration || '0h0m').match(/(\d+)h(\d+)m/); return m ? parseInt(m[1]) * 60 + parseInt(m[2]) : 9999; }
    function deb(fn, ms) { var t; return function() { var a = arguments, ctx = this; clearTimeout(t); t = setTimeout(function() { fn.apply(ctx, a); }, ms); }; }

    init();
})();
