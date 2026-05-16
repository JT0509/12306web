/* global fetch, localStorage, setTimeout, clearTimeout, console, window, document */

(function() {
    'use strict';

    // ===== 常量 =====
    const API_BASE = 'http://127.0.0.1:8765';
    const HISTORY_KEY = 'train_query_history';
    const MAX_HISTORY = 5;

    // ===== DOM 引用 =====
    const $ = sel => document.querySelector(sel);
    const $$ = sel => document.querySelectorAll(sel);

    const fromInput = $('#fromInput');
    const toInput = $('#toInput');
    const dateInput = $('#dateInput');
    const searchBtn = $('#searchBtn');
    const swapBtn = $('#swapBtn');
    const statusBar = $('#statusBar');
    const results = $('#results');
    const filterRow = $('#filterRow');
    const fromSuggestions = $('#fromSuggestions');
    const toSuggestions = $('#toSuggestions');

    // ===== 初始化 =====
    function init() {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        dateInput.min = tomorrow.toISOString().split('T')[0];
        dateInput.value = tomorrow.toISOString().split('T')[0];

        loadHistory();
        bindEvents();
    }

    // ===== 事件绑定 =====
    function bindEvents() {
        searchBtn.addEventListener('click', doSearch);
        swapBtn.addEventListener('click', swapStations);
        fromInput.addEventListener('input', debounce(function() { suggestStations(fromInput, fromSuggestions); }, 250));
        toInput.addEventListener('input', debounce(function() { suggestStations(toInput, toSuggestions); }, 250));
        document.addEventListener('click', closeSuggestions);

        $$('input[name="sort"]').forEach(function(r) {
            r.addEventListener('change', function() {
                if (results.children.length > 0) doSearch();
            });
        });

        $$('.filter-btn').forEach(function(b) {
            b.addEventListener('click', function() {
                $$('.filter-btn').forEach(function(x) { x.classList.remove('active'); });
                this.classList.add('active');
                applyFilter(this.dataset.filter);
            });
        });
    }

    // ===== 车站建议 =====
    async function suggestStations(input, listEl) {
        var q = input.value.trim();
        if (q.length < 1) { listEl.classList.remove('show'); return; }
        try {
            var resp = await fetch(API_BASE + '/api/stations?q=' + encodeURIComponent(q));
            var data = await resp.json();
            renderSuggestions(listEl, data.stations || [], input);
        } catch (e) {
            console.error('车站搜索失败', e);
        }
    }

    function renderSuggestions(el, stations, input) {
        el.innerHTML = '';
        if (stations.length === 0) { el.classList.remove('show'); return; }
        stations.forEach(function(s) {
            var li = document.createElement('li');
            li.textContent = s;
            li.addEventListener('mousedown', function() {
                input.value = s;
                el.classList.remove('show');
            });
            el.appendChild(li);
        });
        el.classList.add('show');
    }

    function closeSuggestions(e) {
        if (!e.target.closest('.input-group')) {
            fromSuggestions.classList.remove('show');
            toSuggestions.classList.remove('show');
        }
    }

    // ===== 交换车站 =====
    function swapStations() {
        var tmp = fromInput.value;
        fromInput.value = toInput.value;
        toInput.value = tmp;
    }

    // ===== 输入校验 =====
    function validateInputs() {
        var ok = true;
        [fromInput, toInput].forEach(function(inp) {
            inp.classList.remove('error');
            if (!inp.value.trim()) {
                inp.classList.add('error');
                ok = false;
            }
        });
        return ok;
    }

    // ===== 查询 =====
    async function doSearch() {
        if (!validateInputs()) {
            showStatus('请填写出发站和到达站', 'error');
            return;
        }

        var from = fromInput.value.trim();
        var to = toInput.value.trim();
        var date = dateInput.value;
        var sortBy = (document.querySelector('input[name="sort"]:checked') || {}).value || 'price';

        setLoading(true);
        showStatus('正在查询车次信息...', 'loading');
        results.innerHTML = renderSkeletons(3);

        try {
            var resp = await fetch(API_BASE + '/api/search', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ from: from, to: to, date: date, sort_by: sortBy }),
            });
            var data = await resp.json();

            if (!resp.ok) {
                showStatus(data.error || '查询失败', 'error');
                results.innerHTML = '';
                return;
            }

            saveHistory({ from: from, to: to, date: date });
            renderResults(data);
            filterRow.style.display = (data.direct.length > 0 && data.transfers.length > 0) ? 'flex' : 'none';
            $$('.filter-btn').forEach(function(b) {
                b.classList.toggle('active', b.dataset.filter === 'all');
            });

            var total = data.direct.length + data.transfers.length;
            if (total === 0) {
                showStatus('未找到该线路的车次，请尝试调整日期或拆段查询', 'warning');
            } else {
                showStatus('找到 ' + data.direct.length + ' 趟直达 + ' + data.transfers.length + ' 个中转方案', 'success');
            }
        } catch (e) {
            console.error('查询失败', e);
            showStatus('网络连接失败，请检查后端服务是否已启动', 'error');
            results.innerHTML = '';
        } finally {
            setLoading(false);
        }
    }

    // ===== 渲染结果 =====
    function renderResults(data) {
        results.innerHTML = '';

        if (data.direct.length > 0) {
            results.appendChild(createSectionTitle('直达车次', data.direct.length, 'direct'));
            data.direct.forEach(function(train, idx, arr) {
                results.appendChild(createTrainCard(train, idx, arr));
            });
        }

        if (data.transfers.length > 0) {
            results.appendChild(createSectionTitle('中转方案', data.transfers.length, 'transfer'));
            data.transfers.forEach(function(t) { results.appendChild(createTransferCard(t)); });
        }

        if (data.direct.length === 0 && data.transfers.length === 0) {
            results.innerHTML = '<div class="empty-state"><div class="empty-icon">🔍</div><p>暂无车次，请尝试其他日期或线路</p></div>';
        }
    }

    function createSectionTitle(text, count, type) {
        var div = document.createElement('div');
        div.className = 'section-title';
        div.dataset.type = type;
        div.innerHTML = '📌 ' + text + ' <span class="count">(' + count + '个)</span>';
        return div;
    }

    function createTrainCard(train, idx, arr) {
        var card = document.createElement('div');
        card.className = 'train-card';
        card.dataset.type = 'direct';

        // 找最低/最快标记
        var minPrice = Math.min.apply(null, arr.map(function(t) { return minPriceOf(t); }).filter(function(p) { return p > 0; }));
        var minDur = Math.min.apply(null, arr.map(function(t) { return durMins(t); }));
        var thisPrice = minPriceOf(train);
        var thisDur = durMins(train);

        var badges = '';
        if (thisPrice > 0 && thisPrice === minPrice) badges += '<span class="badge best-price">💡 最实惠</span>';
        if (thisDur > 0 && thisDur === minDur) badges += '<span class="badge best-time">⚡ 最快</span>';

        var seatsHtml = train.seats.map(function(s) {
            var priceText = s.price ? '¥' + s.price : (s.note || '');
            return '<div class="seat-item"><span class="seat-type">' + escapeHtml(s.type) + '</span><span class="seat-price">' + escapeHtml(priceText) + '</span></div>';
        }).join('');

        // 存储内部车次信息供详情查询使用
        var detailParams = encodeURIComponent(JSON.stringify({
            internal_no: train.internal_no || '',
            from_code: train.from_code || '',
            to_code: train.to_code || '',
        }));

        card.innerHTML =
            '<div class="card-header">' +
                badges +
                '<span class="train-code">' + escapeHtml(train.train_no) + '</span>' +
                '<span class="card-route">' + escapeHtml(train.from_station) + ' <span class="arrow">→</span> ' + escapeHtml(train.to_station) + '</span>' +
                '<span class="card-time">' + escapeHtml(train.depart_time) + ' - ' + escapeHtml(train.arrive_time) + '</span>' +
                '<span style="color:var(--text-secondary);font-size:13px;">' + escapeHtml(train.duration) + '</span>' +
            '</div>' +
            '<div class="seat-list">' + (seatsHtml || '<span style="font-size:12px;color:var(--text-secondary);">暂无可选席别</span>') + '</div>' +
            '<div class="card-actions">' +
                '<button class="btn btn-detail" data-action="detail" data-train="' + escapeHtml(train.train_no) + '" data-extra="' + escapeHtml(detailParams) + '">📋 查看详情</button>' +
                '<button class="btn btn-buy" data-action="buy" data-link="' + escapeHtml(train.buy_link) + '">🔗 去官网购买</button>' +
            '</div>' +
            '<div class="card-detail" data-train-detail="' + escapeHtml(train.train_no) + '"></div>';

        var detailBtn = card.querySelector('.btn-detail');
        if (detailBtn) {
            detailBtn.addEventListener('click', function(e) { toggleDetail(e, train); });
        }
        var buyBtn = card.querySelector('.btn-buy');
        if (buyBtn) {
            buyBtn.addEventListener('click', function(e) { openBuyLink(e, train.buy_link); });
        }
        return card;
    }

    function createTransferCard(transfer) {
        var card = document.createElement('div');
        card.className = 'transfer-card';
        card.dataset.type = 'transfer';

        var segmentsHtml = transfer.segments.map(function(s) {
            return '<div class="transfer-segment">' +
                '<span style="font-weight:600;">' + escapeHtml(s.train_no) + '</span> ' +
                escapeHtml(s.from_station) + ' → ' + escapeHtml(s.to_station) +
                ' <span style="color:var(--text-secondary);">' + escapeHtml(s.depart_time) + ' - ' + escapeHtml(s.arrive_time) + ' (' + escapeHtml(s.duration) + ')</span>' +
            '</div>';
        }).join('') + '<div class="transfer-wait">⏳ 换乘 ' + escapeHtml(transfer.transfer_time) + '</div>';

        var transferTimeStr = transfer.transfer_time || '';
        var match = transferTimeStr.match(/(\d+)h(\d+)m/);
        var shortTransfer = false;
        if (match) {
            var mins = parseInt(match[1]) * 60 + parseInt(match[2]);
            if (mins < 30) shortTransfer = true;
        }

        card.innerHTML =
            '<div class="transfer-header">' +
                '🔄 经 <b>' + escapeHtml(transfer.transfer_station) + '</b> 中转 ' +
                '<span>总价: <b style="color:var(--danger);">¥' + transfer.total_price + '</b></span> ' +
                '<span style="' + (shortTransfer ? 'color:var(--danger);' : '') + '">总耗时: ' + escapeHtml(transfer.total_duration) + '</span>' +
            '</div>' +
            segmentsHtml +
            '<div class="card-actions" style="padding-top:8px;">' +
                '<button class="btn btn-buy" data-action="buy" data-link="https://kyfw.12306.cn/otn/leftTicket/init">🔗 分段购票（去官网）</button>' +
            '</div>' +
            '<div class="card-detail" data-train-detail="transfer-' + escapeHtml(transfer.transfer_station) + '"></div>';
        return card;
    }

    // ===== 详情展开 =====
    async function toggleDetail(e, train) {
        var card = e.target.closest('.train-card, .transfer-card');
        var detailEl = card ? card.querySelector('.card-detail') : null;
        if (!detailEl) return;

        if (detailEl.classList.contains('show')) {
            detailEl.classList.remove('show');
            return;
        }

        var date = dateInput.value;
        detailEl.innerHTML = '<div class="skeleton-line" style="width:80%;"></div><div class="skeleton-line" style="width:60%;"></div>';
        detailEl.classList.add('show');

        // 构建带车次内部参数的 URL
        var url = API_BASE + '/api/train/' + encodeURIComponent(train.train_no) + '?date=' + encodeURIComponent(date);
        if (train.internal_no) {
            url += '&internal_no=' + encodeURIComponent(train.internal_no);
            url += '&from_code=' + encodeURIComponent(train.from_code || '');
            url += '&to_code=' + encodeURIComponent(train.to_code || '');
        }

        try {
            var resp = await fetch(url);
            if (!resp.ok) {
                detailEl.innerHTML = '<p style="color:var(--danger);font-size:13px;">详情加载失败：' + escapeHtml((await resp.json()).error || '') + '</p>';
                return;
            }
            var data = await resp.json();
            detailEl.innerHTML = '<div class="route-timeline">' +
                data.route.map(function(s) {
                    return '<div class="route-stop">' +
                        '<div class="station-name">' + escapeHtml(s.station) + '</div>' +
                        '<div class="station-time">到 ' + escapeHtml(s.arrive) + ' 发 ' + escapeHtml(s.depart) + '</div>' +
                    '</div>';
                }).join('') +
            '</div>';
        } catch (er) {
            detailEl.innerHTML = '<p style="color:var(--danger);font-size:13px;">详情加载失败</p>';
        }
    }

    // ===== 跳转购买 =====
    function openBuyLink(e, link) {
        e.stopPropagation();
        try {
            var url = new URL(link);
            if (url.hostname.indexOf('12306.cn') === -1) {
                showStatus('链接无效，已被拦截', 'error');
                return;
            }
        } catch (err) {
            showStatus('链接无效，已被拦截', 'error');
            return;
        }
        window.open(link, '_blank', 'noopener');
    }

    // ===== 筛选 =====
    function applyFilter(filter) {
        $$('.train-card, .transfer-card, .section-title').forEach(function(el) {
            if (filter === 'all') { el.style.display = ''; return; }
            if (el.dataset.type === filter) el.style.display = '';
            else if (el.dataset.type) el.style.display = 'none';
        });
    }

    // ===== 骨架屏 =====
    function renderSkeletons(n) {
        return Array(n).fill(0).map(function() {
            return '<div class="skeleton"><div class="skeleton-line" style="width:40%;"></div><div class="skeleton-line" style="width:70%;"></div><div class="skeleton-line"></div></div>';
        }).join('');
    }

    // ===== 状态提示 =====
    function showStatus(msg, type) {
        statusBar.innerHTML = '<div class="status-msg ' + type + '">' + msg + '</div>';
    }

    // ===== 加载态 =====
    function setLoading(loading) {
        searchBtn.disabled = loading;
        searchBtn.textContent = loading ? '查询中...' : '🔍 查询';
        fromInput.disabled = loading;
        toInput.disabled = loading;
        dateInput.disabled = loading;
    }

    // ===== 查询历史 =====
    function saveHistory(query) {
        try {
            var history = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
            history = history.filter(function(h) { return !(h.from === query.from && h.to === query.to); });
            history.unshift(query);
            history = history.slice(0, MAX_HISTORY);
            localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
            loadHistory();
        } catch (e) { /* ignore */ }
    }

    function loadHistory() {
        try {
            var history = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
            var bar = $('.history-bar');
            if (!bar) {
                bar = document.createElement('div');
                bar.className = 'history-bar';
                $('#searchPanel').insertBefore(bar, $('.search-row'));
            }
            bar.innerHTML = history.length > 0 ? '<span style="font-size:12px;color:var(--text-secondary);">最近查询:</span>' : '';
            history.forEach(function(h) {
                var tag = document.createElement('span');
                tag.className = 'history-tag';
                tag.textContent = h.from + '→' + h.to;
                tag.addEventListener('click', function() {
                    fromInput.value = h.from;
                    toInput.value = h.to;
                    dateInput.value = h.date;
                    doSearch();
                });
                bar.appendChild(tag);
            });
        } catch (e) { /* ignore */ }
    }

    // ===== 工具函数 =====
    function escapeHtml(str) {
        if (!str) return '';
        var div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function minPriceOf(train) {
        var prices = (train.seats || []).map(function(s) { return s.price || 0; }).filter(function(p) { return p > 0; });
        return prices.length > 0 ? Math.min.apply(null, prices) : 0;
    }

    function durMins(train) {
        var d = train.duration || '0h0m';
        var m = d.match(/(\d+)h(\d+)m/);
        return m ? parseInt(m[1]) * 60 + parseInt(m[2]) : 9999;
    }

    function debounce(fn, delay) {
        var timer;
        return function() {
            var args = arguments;
            var ctx = this;
            clearTimeout(timer);
            timer = setTimeout(function() { fn.apply(ctx, args); }, delay);
        };
    }

    // ===== 启动 =====
    init();
})();
