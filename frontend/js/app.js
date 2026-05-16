/* global fetch, localStorage, AbortController, setTimeout, clearTimeout, console, window, document */

(function() {
    'use strict';

    var API = 'http://127.0.0.1:8765';
    var HISTORY_KEY = 'train_query_history';
    var MAX_HISTORY = 5;
    var searchCtrl = null;   // 搜索请求的 AbortController
    var priceCtrl = null;    // 价格请求的 AbortController
    var detailCtrl = null;   // 详情请求的 AbortController

    var $ = function(s) { return document.querySelector(s); };
    var $$ = function(s) { return document.querySelectorAll(s); };

    var fromInput = $('#fromInput');
    var toInput = $('#toInput');
    var dateInput = $('#dateInput');
    var searchBtn = $('#searchBtn');
    var cancelBtn = $('#cancelBtn');
    var swapBtn = $('#swapBtn');
    var statusBar = $('#statusBar');
    var resultsEl = $('#results');
    var filterRow = $('#filterRow');
    var fromSug = $('#fromSuggestions');
    var toSug = $('#toSuggestions');

    // ===== 初始化 =====
    function init() {
        var t = new Date();
        t.setDate(t.getDate() + 1);
        var ds = t.toISOString().split('T')[0];
        dateInput.min = ds;
        dateInput.value = ds;
        loadHistory();
        bindEvents();
    }

    function bindEvents() {
        searchBtn.addEventListener('click', doSearch);
        cancelBtn.addEventListener('click', cancelAll);
        swapBtn.addEventListener('click', swapStations);
        fromInput.addEventListener('input', debounce(function() { suggest(fromInput, fromSug); }, 250));
        toInput.addEventListener('input', debounce(function() { suggest(toInput, toSug); }, 250));
        document.addEventListener('click', closeSug);

        $$('input[name="sort"]').forEach(function(r) {
            r.addEventListener('change', function() { if (resultsEl.children.length) doSearch(); });
        });
        $$('.filter-btn').forEach(function(b) {
            b.addEventListener('click', function() {
                $$('.filter-btn').forEach(function(x) { x.classList.remove('active'); });
                this.classList.add('active');
                applyFilter(this.dataset.filter);
            });
        });
    }

    // ===== 取消全部操作 =====
    function cancelAll() {
        if (searchCtrl) { searchCtrl.abort(); searchCtrl = null; }
        if (priceCtrl) { priceCtrl.abort(); priceCtrl = null; }
        if (detailCtrl) { detailCtrl.abort(); detailCtrl = null; }
        setLoading(false);
        showStatus('已取消', 'warning');
    }

    // ===== 车站建议 =====
    async function suggest(input, listEl) {
        var q = input.value.trim();
        if (q.length < 1) { listEl.classList.remove('show'); return; }
        try {
            var r = await fetch(API + '/api/stations?q=' + encodeURIComponent(q));
            var d = await r.json();
            renderSug(listEl, d.stations || [], input);
        } catch (e) {}
    }

    function renderSug(el, stations, input) {
        el.innerHTML = '';
        if (!stations.length) { el.classList.remove('show'); return; }
        stations.forEach(function(s) {
            var li = document.createElement('li');
            li.textContent = s;
            li.addEventListener('mousedown', function() { input.value = s; el.classList.remove('show'); });
            el.appendChild(li);
        });
        el.classList.add('show');
    }

    function closeSug(e) {
        if (!e.target.closest('.input-group')) { fromSug.classList.remove('show'); toSug.classList.remove('show'); }
    }

    function swapStations() {
        var t = fromInput.value;
        fromInput.value = toInput.value;
        toInput.value = t;
    }

    function validateInputs() {
        var ok = true;
        [fromInput, toInput].forEach(function(inp) {
            inp.classList.remove('error');
            if (!inp.value.trim()) { inp.classList.add('error'); ok = false; }
        });
        return ok;
    }

    // ===== 查询 =====
    async function doSearch() {
        if (!validateInputs()) { showStatus('请填写出发站和到达站', 'error'); return; }

        cancelAll();

        searchCtrl = new AbortController();
        var from = fromInput.value.trim();
        var to = toInput.value.trim();
        var date = dateInput.value;
        var sortBy = (document.querySelector('input[name="sort"]:checked') || {}).value || 'price';

        setLoading(true);
        showStatus('正在查询车次... <small>(可点取消)</small>', 'loading');
        resultsEl.innerHTML = renderSkeletons(3);

        var data;
        try {
            var resp = await fetch(API + '/api/search', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ from: from, to: to, date: date, sort_by: sortBy }),
                signal: searchCtrl.signal,
            });
            data = await resp.json();
            if (!resp.ok) { showStatus(data.error || '查询失败', 'error'); resultsEl.innerHTML = ''; setLoading(false); return; }
        } catch (e) {
            if (e.name === 'AbortError') { setLoading(false); return; }
            showStatus('网络连接失败，请检查后端', 'error');
            resultsEl.innerHTML = '';
            setLoading(false);
            return;
        }

        searchCtrl = null;
        setLoading(false);
        saveHistory({ from: from, to: to, date: date });

        renderResults(data);
        filterRow.style.display = (data.direct.length && data.transfers.length) ? 'flex' : 'none';
        $$('.filter-btn').forEach(function(b) { b.classList.toggle('active', b.dataset.filter === 'all'); });

        var total = data.direct.length + data.transfers.length;
        if (!total) {
            showStatus('暂无车次，请调整日期或线路', 'warning');
        } else {
            showStatus('找到 ' + data.direct.length + ' 趟直达 + ' + data.transfers.length + ' 个中转  |  正在获取票价...', 'success');
            fetchPrices(data.direct, date);
        }
    }

    // ===== 异步价格 =====
    async function fetchPrices(trains, date) {
        if (!trains.length) return;

        priceCtrl = new AbortController();

        var payload = trains.map(function(t) {
            return {
                train_no: t.train_no,
                internal_no: t.internal_no,
                from_no: String(t.from_no || ''),
                to_no: String(t.to_no || ''),
                seat_types: t.seat_types || '',
            };
        });

        try {
            var resp = await fetch(API + '/api/price', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ trains: payload, date: dateInput.value }),
                signal: priceCtrl.signal,
            });
            var data = await resp.json();
            var pmap = data.prices || {};

            trains.forEach(function(train) {
                var prices = pmap[train.train_no] || {};
                var card = document.querySelector('.train-card[data-train-no="' + cssEscape(train.train_no) + '"]');
                if (!card) return;
                var seatList = card.querySelector('.seat-list');
                if (!seatList) return;

                var html = '';
                train.seats.forEach(function(s) {
                    var p = prices[s.type];
                    var pt;
                    if (p !== undefined && p > 0) {
                        pt = '<span class="seat-price">¥' + p + '</span>';
                    } else if (p !== undefined && p === 0) {
                        pt = '<span class="seat-price" style="color:var(--text-secondary);">价格未知</span>';
                    } else {
                        pt = '<span class="seat-price" style="color:var(--text-secondary);">—</span>';
                    }
                    html += '<div class="seat-item"><span class="seat-type">' + esc(s.type) + '</span>' + pt + '</div>';
                });
                seatList.innerHTML = html || '<span style="font-size:12px;color:var(--text-secondary);">暂无可选席别</span>';
            });

            // 更新最实惠标记
            updateBestBadge();

            showStatus('票价加载完成', 'success');
        } catch (e) {
            if (e.name === 'AbortError') return;
            // 价格加载失败不阻塞，页面上保留 "—"
        }
        priceCtrl = null;
    }

    function updateBestBadge() {
        var cards = $$('.train-card');
        var bestP = Infinity;
        var bestNo = '';
        cards.forEach(function(card) {
            card.querySelectorAll('.seat-price').forEach(function(el) {
                var v = parseFloat(el.textContent.replace('¥', ''));
                if (v > 0 && v < bestP) { bestP = v; bestNo = card.dataset.trainNo; }
            });
        });
        cards.forEach(function(card) {
            var old = card.querySelector('.badge.best-price');
            if (old) old.remove();
            if (card.dataset.trainNo === bestNo && bestP < Infinity) {
                var h = card.querySelector('.card-header');
                if (h) h.insertAdjacentHTML('afterbegin', '<span class="badge best-price">💡 最实惠</span>');
            }
        });
    }

    // ===== 渲染 =====
    function renderResults(data) {
        resultsEl.innerHTML = '';
        if (data.direct.length) {
            resultsEl.appendChild(sectionTitle('直达车次', data.direct.length, 'direct'));
            data.direct.forEach(function(t, i, a) { resultsEl.appendChild(trainCard(t, i, a)); });
        }
        if (data.transfers.length) {
            resultsEl.appendChild(sectionTitle('中转方案', data.transfers.length, 'transfer'));
            data.transfers.forEach(function(t) { resultsEl.appendChild(transferCard(t)); });
        }
        if (!data.direct.length && !data.transfers.length) {
            resultsEl.innerHTML = '<div class="empty-state"><div class="empty-icon">🔍</div><p>暂无车次</p></div>';
        }
    }

    function sectionTitle(text, count, type) {
        var d = document.createElement('div');
        d.className = 'section-title';
        d.dataset.type = type;
        d.innerHTML = '📌 ' + text + ' <span class="count">(' + count + '个)</span>';
        return d;
    }

    function trainCard(train, idx, arr) {
        var card = document.createElement('div');
        card.className = 'train-card';
        card.dataset.type = 'direct';
        card.dataset.trainNo = train.train_no;

        var minD = Math.min.apply(null, arr.map(durMins));
        var thisD = durMins(train);
        var badges = thisD > 0 && thisD === minD ? '<span class="badge best-time">⚡ 最快</span>' : '';

        var seatsHtml = train.seats.map(function(s) {
            return '<div class="seat-item"><span class="seat-type">' + esc(s.type) + '</span><span class="seat-price" style="color:var(--text-secondary);">加载中...</span></div>';
        }).join('');

        // 把车次内部参数编码存 data 属性
        card.dataset.internalNo = train.internal_no || '';
        card.dataset.fromCode = train.from_code || '';
        card.dataset.toCode = train.to_code || '';

        card.innerHTML =
            '<div class="card-header">' + badges +
                '<span class="train-code">' + esc(train.train_no) + '</span>' +
                '<span class="card-route">' + esc(train.from_station) + ' <span class="arrow">→</span> ' + esc(train.to_station) + '</span>' +
                '<span class="card-time">' + esc(train.depart_time) + ' - ' + esc(train.arrive_time) + '</span>' +
                '<span style="color:var(--text-secondary);font-size:13px;">' + esc(train.duration) + '</span>' +
            '</div>' +
            '<div class="seat-list">' + (seatsHtml || '<span style="font-size:12px;">—</span>') + '</div>' +
            '<div class="card-actions">' +
                '<button class="btn btn-detail">📋 查看详情</button>' +
                '<button class="btn btn-buy">🔗 去官网购买</button>' +
            '</div>' +
            '<div class="card-detail"></div>';

        card.querySelector('.btn-detail').addEventListener('click', function(e) {
            toggleDetail(e, card, train);
        });
        card.querySelector('.btn-buy').addEventListener('click', function(e) {
            openBuy(e, train);
        });
        return card;
    }

    function transferCard(t) {
        var card = document.createElement('div');
        card.className = 'transfer-card';
        card.dataset.type = 'transfer';

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
    async function toggleDetail(e, card, train) {
        var detailEl = card.querySelector('.card-detail');
        if (!detailEl) return;

        if (detailEl.classList.contains('show')) {
            detailEl.classList.remove('show');
            if (detailCtrl) { detailCtrl.abort(); detailCtrl = null; }
            return;
        }

        // 取消之前的详情请求
        if (detailCtrl) { detailCtrl.abort(); }
        detailCtrl = new AbortController();

        detailEl.innerHTML = '<div class="skeleton-line" style="width:80%;"></div><div class="skeleton-line" style="width:60%;"></div>' +
            '<button class="btn btn-detail" style="margin-top:8px;font-size:11px;" onclick="this.closest(\'.card-detail\').classList.remove(\'show\');">✕ 取消</button>';
        detailEl.classList.add('show');

        var date = dateInput.value;
        var url = API + '/api/train/' + encodeURIComponent(train.train_no) + '?date=' + encodeURIComponent(date);
        // 传内部参数确保查询成功
        var ino = train.internal_no || card.dataset.internalNo || '';
        var fc = train.from_code || card.dataset.fromCode || '';
        var tc = train.to_code || card.dataset.toCode || '';
        if (ino) {
            url += '&internal_no=' + encodeURIComponent(ino);
            url += '&from_code=' + encodeURIComponent(fc);
            url += '&to_code=' + encodeURIComponent(tc);
        }

        try {
            var resp = await fetch(url, { signal: detailCtrl.signal });
            if (!resp.ok) {
                var ed = await resp.json().catch(function() { return { error: '未知错误' }; });
                detailEl.innerHTML = '<p style="color:var(--danger);font-size:13px;padding:8px;">详情加载失败: ' + esc(ed.error || '') + '</p>';
                return;
            }
            var data = await resp.json();
            var stopsHtml = data.route.map(function(s) {
                return '<div class="route-stop"><div class="station-name">' + esc(s.station) +
                    '</div><div class="station-time">到 ' + esc(s.arrive) + ' 发 ' + esc(s.depart) + '</div></div>';
            }).join('');
            detailEl.innerHTML = '<div class="route-timeline">' + stopsHtml + '</div>';
        } catch (e) {
            if (e.name === 'AbortError') { detailEl.innerHTML = ''; detailEl.classList.remove('show'); return; }
            detailEl.innerHTML = '<p style="color:var(--danger);font-size:13px;padding:8px;">详情加载失败</p>';
        }
        detailCtrl = null;
    }

    // ===== 购买跳转 =====
    function openBuy(e, train) {
        e.stopPropagation();
        var link = train.buy_link || 'https://kyfw.12306.cn/otn/leftTicket/init';
        try {
            var u = new URL(link);
            if (u.hostname.indexOf('12306.cn') === -1) { showStatus('链接被拦截', 'error'); return; }
        } catch (er) { showStatus('链接无效', 'error'); return; }
        // 在新标签页打开 12306 搜索页（已预填日期+起终点）
        window.open(link, '_blank', 'noopener');
        showStatus('已打开 12306 官网，请在结果列表中找到对应车次点击"预订"即可购票', 'success');
    }

    function applyFilter(filter) {
        $$('.train-card, .transfer-card, .section-title').forEach(function(el) {
            if (filter === 'all') { el.style.display = ''; return; }
            el.style.display = (el.dataset.type === filter) ? '' : 'none';
        });
    }

    function renderSkeletons(n) {
        return Array(n).fill(0).map(function() {
            return '<div class="skeleton"><div class="skeleton-line" style="width:40%;"></div>' +
                '<div class="skeleton-line" style="width:70%;"></div><div class="skeleton-line"></div></div>';
        }).join('');
    }

    function showStatus(msg, type) {
        statusBar.innerHTML = '<div class="status-msg ' + type + '">' + msg + '</div>';
    }

    function setLoading(on) {
        searchBtn.style.display = on ? 'none' : '';
        cancelBtn.style.display = on ? '' : 'none';
        searchBtn.disabled = on;
        fromInput.disabled = on;
        toInput.disabled = on;
        dateInput.disabled = on;
    }

    function saveHistory(q) {
        try {
            var h = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
            h = h.filter(function(x) { return !(x.from === q.from && x.to === q.to); });
            h.unshift(q);
            localStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(0, MAX_HISTORY)));
            loadHistory();
        } catch (e) {}
    }

    function loadHistory() {
        try {
            var h = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
            var bar = $('.history-bar');
            if (!bar) {
                bar = document.createElement('div');
                bar.className = 'history-bar';
                $('#searchPanel').insertBefore(bar, $('.search-row'));
            }
            bar.innerHTML = h.length ? '<span style="font-size:12px;color:var(--text-secondary);">最近查询:</span>' : '';
            h.forEach(function(q) {
                var tag = document.createElement('span');
                tag.className = 'history-tag';
                tag.textContent = q.from + '→' + q.to;
                tag.addEventListener('click', function() {
                    fromInput.value = q.from;
                    toInput.value = q.to;
                    dateInput.value = q.date;
                    doSearch();
                });
                bar.appendChild(tag);
            });
        } catch (e) {}
    }

    // ===== 工具 =====
    function esc(s) {
        if (!s) return '';
        var d = document.createElement('div');
        d.textContent = s;
        return d.innerHTML;
    }

    function cssEscape(s) {
        return s.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
    }

    function durMins(t) {
        var m = (t.duration || '0h0m').match(/(\d+)h(\d+)m/);
        return m ? parseInt(m[1]) * 60 + parseInt(m[2]) : 9999;
    }

    function debounce(fn, ms) {
        var t;
        return function() {
            var a = arguments, ctx = this;
            clearTimeout(t);
            t = setTimeout(function() { fn.apply(ctx, a); }, ms);
        };
    }

    init();
})();
