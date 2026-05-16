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
        fromInput.addEventListener('input', debounce(() => suggestStations(fromInput, fromSuggestions), 250));
        toInput.addEventListener('input', debounce(() => suggestStations(toInput, toSuggestions), 250));
        document.addEventListener('click', closeSuggestions);

        $$('input[name="sort"]').forEach(r => r.addEventListener('change', () => {
            if (results.children.length > 0) doSearch();
        }));

        $$('.filter-btn').forEach(b => b.addEventListener('click', function() {
            $$('.filter-btn').forEach(x => x.classList.remove('active'));
            this.classList.add('active');
            applyFilter(this.dataset.filter);
        }));
    }

    // ===== 车站建议 =====
    async function suggestStations(input, listEl) {
        const q = input.value.trim();
        if (q.length < 1) { listEl.classList.remove('show'); return; }
        try {
            const resp = await fetch(`${API_BASE}/api/stations?q=${encodeURIComponent(q)}`);
            const data = await resp.json();
            renderSuggestions(listEl, data.stations || [], input);
        } catch (e) {
            console.error('车站搜索失败', e);
        }
    }

    function renderSuggestions(el, stations, input) {
        el.innerHTML = '';
        if (stations.length === 0) { el.classList.remove('show'); return; }
        stations.forEach(s => {
            const li = document.createElement('li');
            li.textContent = s;
            li.addEventListener('mousedown', () => {
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
        const tmp = fromInput.value;
        fromInput.value = toInput.value;
        toInput.value = tmp;
    }

    // ===== 输入校验 =====
    function validateInputs() {
        let ok = true;
        [fromInput, toInput].forEach(inp => {
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

        const from = fromInput.value.trim();
        const to = toInput.value.trim();
        const date = dateInput.value;
        const sortBy = document.querySelector('input[name="sort"]:checked')?.value || 'price';

        setLoading(true);
        showStatus('正在查询车次信息...', 'loading');
        results.innerHTML = renderSkeletons(3);

        try {
            const resp = await fetch(`${API_BASE}/api/search`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ from, to, date, sort_by: sortBy }),
            });
            const data = await resp.json();

            if (!resp.ok) {
                showStatus(data.error || '查询失败', 'error');
                results.innerHTML = '';
                return;
            }

            saveHistory({ from, to, date });
            renderResults(data);
            filterRow.style.display = (data.direct.length > 0 && data.transfers.length > 0) ? 'flex' : 'none';
            $$('.filter-btn').forEach(b => b.classList.toggle('active', b.dataset.filter === 'all'));

            const total = data.direct.length + data.transfers.length;
            if (total === 0) {
                showStatus('未找到该线路的车次，请尝试调整日期或拆段查询', 'warning');
            } else {
                showStatus(`找到 ${data.direct.length} 趟直达 + ${data.transfers.length} 个中转方案`, 'success');
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
            data.direct.forEach((train, idx, arr) => {
                results.appendChild(createTrainCard(train, idx, arr));
            });
        }

        if (data.transfers.length > 0) {
            results.appendChild(createSectionTitle('中转方案', data.transfers.length, 'transfer'));
            data.transfers.forEach(t => results.appendChild(createTransferCard(t)));
        }

        if (data.direct.length === 0 && data.transfers.length === 0) {
            results.innerHTML = '<div class="empty-state"><div class="empty-icon">🔍</div><p>暂无车次，请尝试其他日期或线路</p></div>';
        }
    }

    function createSectionTitle(text, count, type) {
        const div = document.createElement('div');
        div.className = 'section-title';
        div.dataset.type = type;
        div.innerHTML = `📌 ${text} <span class="count">(${count}个)</span>`;
        return div;
    }

    function createTrainCard(train, idx, arr) {
        const card = document.createElement('div');
        card.className = 'train-card';
        card.dataset.type = 'direct';

        // 找最低/最快标记
        const minPrice = Math.min(...arr.map(t => minPriceOf(t)).filter(p => p > 0));
        const minDur = Math.min(...arr.map(t => durMins(t)));
        const thisPrice = minPriceOf(train);
        const thisDur = durMins(train);

        let badges = '';
        if (thisPrice > 0 && thisPrice === minPrice) badges += '<span class="badge best-price">💡 最实惠</span>';
        if (thisDur > 0 && thisDur === minDur) badges += '<span class="badge best-time">⚡ 最快</span>';

        const seatsHtml = train.seats.map(s => {
            const cls = s.sold_out ? 'seat-item sold-out' : 'seat-item';
            const price = s.sold_out ? '已售罄' : `¥${s.price}`;
            return `<div class="${cls}"><span class="seat-type">${escapeHtml(s.type)}</span><span class="seat-price">${price}</span></div>`;
        }).join('');

        card.innerHTML = `
            <div class="card-header">
                ${badges}
                <span class="train-code">${escapeHtml(train.train_no)}</span>
                <span class="card-route">${escapeHtml(train.from_station)} <span class="arrow">→</span> ${escapeHtml(train.to_station)}</span>
                <span class="card-time">${escapeHtml(train.depart_time)} - ${escapeHtml(train.arrive_time)}</span>
                <span style="color:var(--text-secondary);font-size:13px;">${escapeHtml(train.duration)}</span>
            </div>
            <div class="seat-list">${seatsHtml || '<span style="font-size:12px;color:var(--text-secondary);">暂无可选席别</span>'}</div>
            <div class="card-actions">
                <button class="btn btn-detail" data-action="detail" data-train="${escapeHtml(train.train_no)}">📋 查看详情</button>
                <button class="btn btn-buy" data-action="buy" data-link="${escapeHtml(train.buy_link)}">🔗 去官网购买</button>
            </div>
            <div class="card-detail" data-train-detail="${escapeHtml(train.train_no)}"></div>
        `;

        card.querySelector('.btn-detail')?.addEventListener('click', e => toggleDetail(e, train.train_no));
        card.querySelector('.btn-buy')?.addEventListener('click', e => openBuyLink(e, train.buy_link));
        return card;
    }

    function createTransferCard(transfer) {
        const card = document.createElement('div');
        card.className = 'transfer-card';
        card.dataset.type = 'transfer';

        const segmentsHtml = transfer.segments.map(s => `
            <div class="transfer-segment">
                <span style="font-weight:600;">${escapeHtml(s.train_no)}</span>
                ${escapeHtml(s.from_station)} → ${escapeHtml(s.to_station)}
                <span style="color:var(--text-secondary);">${escapeHtml(s.depart_time)} - ${escapeHtml(s.arrive_time)} (${escapeHtml(s.duration)})</span>
            </div>
        `).join('') + `<div class="transfer-wait">⏳ 换乘 ${escapeHtml(transfer.transfer_time)}</div>`;

        const warnClass = '';
        // Warning for short transfer times
        const transferTimeStr = transfer.transfer_time || '';
        const match = transferTimeStr.match(/(\d+)h(\d+)m/);
        let shortTransfer = false;
        if (match) {
            const mins = parseInt(match[1]) * 60 + parseInt(match[2]);
            if (mins < 30) shortTransfer = true;
        }

        card.innerHTML = `
            <div class="transfer-header">
                🔄 经 <b>${escapeHtml(transfer.transfer_station)}</b> 中转
                <span>总价: <b style="color:var(--danger);">¥${transfer.total_price}</b></span>
                <span style="${shortTransfer ? 'color:var(--danger);' : ''}">总耗时: ${escapeHtml(transfer.total_duration)}</span>
            </div>
            ${segmentsHtml}
            <div class="card-actions" style="padding-top:8px;">
                <button class="btn btn-buy" data-action="buy" data-link="https://kyfw.12306.cn/otn/leftTicket/init">🔗 分段购票（去官网）</button>
            </div>
            <div class="card-detail" data-train-detail="transfer-${escapeHtml(transfer.transfer_station)}"></div>
        `;
        return card;
    }

    // ===== 详情展开 =====
    async function toggleDetail(e, trainNo) {
        const card = e.target.closest('.train-card, .transfer-card');
        const detailEl = card?.querySelector('.card-detail');
        if (!detailEl) return;

        if (detailEl.classList.contains('show')) {
            detailEl.classList.remove('show');
            return;
        }

        const date = dateInput.value;
        detailEl.innerHTML = '<div class="skeleton-line" style="width:80%;"></div><div class="skeleton-line" style="width:60%;"></div>';
        detailEl.classList.add('show');

        try {
            const resp = await fetch(`${API_BASE}/api/train/${encodeURIComponent(trainNo)}?date=${encodeURIComponent(date)}`);
            const data = await resp.json();
            detailEl.innerHTML = `
                <div class="route-timeline">
                    ${data.route.map(s => `
                        <div class="route-stop">
                            <div class="station-name">${escapeHtml(s.station)}</div>
                            <div class="station-time">到 ${escapeHtml(s.arrive)} 发 ${escapeHtml(s.depart)}</div>
                        </div>
                    `).join('')}
                </div>
            `;
        } catch (e) {
            detailEl.innerHTML = '<p style="color:var(--danger);font-size:13px;">详情加载失败</p>';
        }
    }

    // ===== 跳转购买 =====
    function openBuyLink(e, link) {
        e.stopPropagation();
        try {
            const url = new URL(link);
            if (!url.hostname.endsWith('12306.cn')) {
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
        $$('.train-card, .transfer-card, .section-title').forEach(el => {
            if (filter === 'all') { el.style.display = ''; return; }
            if (el.dataset.type === filter) el.style.display = '';
            else if (el.dataset.type) el.style.display = 'none';
        });
    }

    // ===== 骨架屏 =====
    function renderSkeletons(n) {
        return Array(n).fill(0).map(() => `
            <div class="skeleton">
                <div class="skeleton-line" style="width:40%;"></div>
                <div class="skeleton-line" style="width:70%;"></div>
                <div class="skeleton-line"></div>
            </div>
        `).join('');
    }

    // ===== 状态提示 =====
    function showStatus(msg, type) {
        statusBar.innerHTML = `<div class="status-msg ${type}">${msg}</div>`;
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
            let history = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
            history = history.filter(h => !(h.from === query.from && h.to === query.to));
            history.unshift(query);
            history = history.slice(0, MAX_HISTORY);
            localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
            loadHistory();
        } catch (e) { /* ignore */ }
    }

    function loadHistory() {
        try {
            const history = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
            let bar = $('.history-bar');
            if (!bar) {
                bar = document.createElement('div');
                bar.className = 'history-bar';
                $('#searchPanel').insertBefore(bar, $('.search-row'));
            }
            bar.innerHTML = history.length > 0 ? '<span style="font-size:12px;color:var(--text-secondary);">最近查询:</span>' : '';
            history.forEach(h => {
                const tag = document.createElement('span');
                tag.className = 'history-tag';
                tag.textContent = `${h.from}→${h.to}`;
                tag.addEventListener('click', () => {
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
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function minPriceOf(train) {
        const prices = (train.seats || []).map(s => s.price || 0).filter(p => p > 0);
        return prices.length > 0 ? Math.min(...prices) : 0;
    }

    function durMins(train) {
        const d = train.duration || '0h0m';
        const m = d.match(/(\d+)h(\d+)m/);
        return m ? parseInt(m[1]) * 60 + parseInt(m[2]) : 9999;
    }

    function debounce(fn, delay) {
        let timer;
        return function(...args) {
            clearTimeout(timer);
            timer = setTimeout(() => fn.apply(this, args), delay);
        };
    }

    // ===== 启动 =====
    init();
})();
