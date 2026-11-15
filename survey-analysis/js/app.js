/* 界面与应用逻辑。所有数据派生文本一律走 textContent，不拼接 innerHTML。 */
(function () {
  'use strict';
  const W = window.SurveyWeights;
  const $ = sel => document.querySelector(sel);

  // ---------- DOM 工具 ----------
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
    for (const c of children.flat(9)) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c.nodeType ? c : document.createTextNode(c));
    }
    return el;
  }
  const SVGNS = 'http://www.w3.org/2000/svg';
  function s(tag, attrs, ...children) {
    const el = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
    for (const c of children.flat(9)) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c.nodeType ? c : document.createTextNode(c));
    }
    return el;
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

  // ---------- 格式化 ----------
  const fmtInt = x => x == null || !isFinite(x) ? '—' : Math.round(x).toLocaleString('zh-CN');
  const fmtNum = (x, d = 2) => x == null || !isFinite(x) ? '—' : (+x).toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d });
  const fmtPct = (x, d = 1) => x == null || !isFinite(x) ? '—' : (x * 100).toFixed(d) + '%';
  function fmtInd(ind, x) {
    if (x == null) return '—';
    if (ind.fmt === 'pct') return fmtPct(x);
    if (ind.fmt === 'num1') return fmtNum(x, 1);
    return fmtInt(x);
  }
  const stratumLabel = key => key.replace('|', ' · ');

  // ---------- 主题 ----------
  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function palette() {
    return {
      text: cssVar('--text-primary'), secondary: cssVar('--text-secondary'), muted: cssVar('--text-muted'),
      grid: cssVar('--gridline'), baseline: cssVar('--baseline'),
      s1: cssVar('--series-1'), s2: cssVar('--series-2'), s3: cssVar('--series-3'),
    };
  }
  $('#btn-theme').addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme;
    const sysDark = matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme = cur ? (cur === 'dark' ? 'light' : 'dark') : (sysDark ? 'light' : 'dark');
    renderAll(); // 图表读取 CSS 变量，需重绘
  });

  // ---------- 提示框 ----------
  const tooltip = $('#tooltip');
  function showTip(x, y, title, rows) {
    clear(tooltip);
    if (title) tooltip.append(h('div', { class: 'tt-title', text: title }));
    for (const r of rows) {
      tooltip.append(h('div', { class: 'tt-row' },
        r.color ? h('span', { class: 'tt-key', style: 'background:' + r.color }) : null,
        h('span', { class: 'tt-val', text: r.value }),
        h('span', { class: 'tt-name', text: r.name })));
    }
    tooltip.hidden = false;
    const rect = tooltip.getBoundingClientRect();
    tooltip.style.left = Math.min(x + 14, innerWidth - rect.width - 8) + 'px';
    tooltip.style.top = Math.max(8, y - rect.height - 12) + 'px';
  }
  function hideTip() { tooltip.hidden = true; }
  // 为 SVG 标记挂载悬停/键盘提示（命中区大于标记本身）
  function bindTip(node, title, rows) {
    const show = e => {
      const pt = e.clientX != null ? { x: e.clientX, y: e.clientY } : (() => { const b = node.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top }; })();
      showTip(pt.x, pt.y, title, typeof rows === 'function' ? rows() : rows);
    };
    node.addEventListener('pointermove', show);
    node.addEventListener('pointerleave', hideTip);
    node.addEventListener('focus', show);
    node.addEventListener('blur', hideTip);
  }

  // ---------- 数据集定义 ----------
  const DATASETS = [
    {
      key: 'frame', name: '抽样框',
      desc: '居民登记名单摘录，每行一人，含分层变量。',
      cols: 'person_id, district, age_group, sex, age',
      required: ['person_id', 'district', 'age_group'],
      template: 'person_id,district,age_group,sex,age\nHB0001,城东区,18-34岁,女,27\nHB0002,滨海区,60岁及以上,男,66',
    },
    {
      key: 'selected', name: '抽中记录',
      desc: '被抽中的人及其入样概率 pi（0–1）。pi 缺失的记录进入不可估计清单。',
      cols: 'person_id, pi, batch',
      required: ['person_id', 'pi'],
      template: 'person_id,pi,batch\nHB0001,0.175610,1\nHB0002,0.731707,2',
    },
    {
      key: 'responses', name: '回答结果',
      desc: '问卷回答，每行一次提交；同一 person_id 多次提交按规则去重。',
      cols: 'person_id, submitted_at, satisfied, community, exercise_hours, monthly_income',
      required: ['person_id', 'submitted_at', 'satisfied', 'community', 'exercise_hours', 'monthly_income'],
      template: 'person_id,submitted_at,satisfied,community,exercise_hours,monthly_income\nHB0001,2026-09-03 10:20:11,满意,参与,3.5,6800\nHB0002,2026-09-04 21:02:40,不满意,未参与,1.0,',
    },
    {
      key: 'population', name: '人口分层总量',
      desc: '各层（区 × 年龄段）人口总量，用于校准。缺总量的层不校准并标注。',
      cols: 'district, age_group, pop_total',
      required: ['district', 'age_group', 'pop_total'],
      template: 'district,age_group,pop_total\n城东区,18-34岁,15000\n滨海区,60岁及以上,3000',
    },
  ];

  const App = {
    data: { frame: null, selected: null, responses: null, population: null },
    meta: {},
    state: null, estimates: null, boot: null,
  };

  function readConfig() {
    return {
      dupRule: $('#dup-rule').value,
      nrGroup: $('#nr-group').value,
      trimCap: $('#trim-enabled').checked && +$('#trim-cap').value > 0 ? +$('#trim-cap').value : null,
      seed: +$('#boot-seed').value || 20261115,
      B: Math.max(100, Math.min(2000, +$('#boot-b').value || 500)),
    };
  }

  const allLoaded = () => DATASETS.every(d => App.data[d.key]);

  // ---------- 数据导入 ----------
  function renderDatasets() {
    const grid = $('#dataset-grid');
    clear(grid);
    for (const d of DATASETS) {
      const meta = App.meta[d.key];
      const status = meta
        ? (meta.error
          ? h('div', { class: 'ds-status bad', text: '✕ ' + meta.error })
          : h('div', { class: 'ds-status ok', text: `✓ 已载入 ${meta.rows} 行（${meta.source}）` }))
        : h('div', { class: 'ds-status idle', text: '○ 未载入' });
      const file = h('input', { type: 'file', accept: '.csv,.json', style: 'display:none' });
      file.addEventListener('change', () => file.files[0] && importFile(d, file.files[0]));
      grid.append(h('div', { class: 'dataset-card' },
        h('h3', { text: d.name }),
        h('div', { class: 'muted', text: d.desc }),
        h('div', { class: 'cols', text: d.cols }),
        status,
        h('div', { class: 'ds-actions' },
          h('button', { class: 'btn ghost', type: 'button', onclick: () => file.click() }, '选择文件'),
          h('button', {
            class: 'btn ghost', type: 'button',
            onclick: () => download(`模板-${d.name}.csv`, '﻿' + d.template + '\n', 'text/csv'),
          }, '下载模板')),
        file));
    }
  }

  function importFile(d, f) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        let rows;
        if (/\.json$/i.test(f.name)) {
          const parsed = JSON.parse(reader.result);
          if (!Array.isArray(parsed)) throw new Error('JSON 须为对象数组');
          rows = parsed.map(o => { const r = {}; for (const k of Object.keys(o)) r[k] = String(o[k] ?? ''); return r; });
        } else {
          rows = W.parseCSV(String(reader.result));
        }
        const missing = d.required.filter(c => rows.length && !(c in rows[0]));
        if (!rows.length) throw new Error('文件没有数据行');
        if (missing.length) throw new Error('缺少字段：' + missing.join(', '));
        App.data[d.key] = rows;
        App.meta[d.key] = { rows: rows.length, source: f.name };
      } catch (e) {
        App.data[d.key] = null;
        App.meta[d.key] = { error: e.message };
      }
      recompute();
    };
    reader.readAsText(f, 'utf-8');
  }

  $('#btn-load-sample').addEventListener('click', () => {
    for (const d of DATASETS) {
      App.data[d.key] = W.parseCSV(window.SAMPLE_DATA[d.key]);
      App.meta[d.key] = { rows: App.data[d.key].length, source: '虚构示例' };
    }
    $('#import-status').textContent = '已载入虚构示例：抽样框 1,200 人 / 抽中 320 人 / 回答 176 行 / 9 个人口层。';
    recompute();
  });
  $('#btn-clear').addEventListener('click', () => {
    for (const d of DATASETS) { App.data[d.key] = null; App.meta[d.key] = null; }
    $('#import-status').textContent = '';
    recompute();
  });

  // ---------- 主管线 ----------
  function recompute() {
    renderDatasets();
    const ready = allLoaded();
    for (const [sec, empty, body] of [
      ['check', '#check-empty', '#check-body'],
      ['weights', '#weights-empty', '#weights-body'],
      ['nonestimable', '#nonest-empty', '#nonest-body'],
      ['estimates', '#est-empty', '#est-body'],
      ['drilldown', '#drill-empty', '#drill-body'],
      ['export', '#export-empty', '#export-body'],
    ]) {
      $(empty).hidden = ready;
      $(body).hidden = !ready;
    }
    if (!ready) { App.state = App.estimates = App.boot = null; return; }
    const cfg = readConfig();
    App.state = W.computePipeline(App.data, cfg);
    App.estimates = W.computeEstimates(App.state);
    App.boot = null; // 配置变更后区间失效，需重新计算
    if (!$('#trim-cap').value) $('#trim-cap').value = Math.round(App.state.weightStats.median * 1.25); // 建议上限：1.25×中位数
    renderAll();
  }

  function renderAll() {
    if (!App.state) return;
    renderCheck();
    renderWeights();
    renderNonEstimable();
    renderEstimates();
    renderDrilldown();
  }

  // 配置变更联动
  for (const id of ['#dup-rule', '#nr-group']) $(id).addEventListener('change', recompute);
  $('#btn-apply-trim').addEventListener('click', recompute);
  $('#trim-enabled').addEventListener('change', () => {
    if ($('#trim-enabled').checked && !$('#trim-cap').value && App.state) {
      $('#trim-cap').value = Math.round(App.state.weightStats.median * 1.25);
    }
    recompute();
  });

  // ---------- 通用表格 ----------
  function dataTable(caption, head, rows, rowClass) {
    const t = h('table', { class: 'data' });
    if (caption) t.append(h('caption', { text: caption }));
    t.append(h('thead', null, h('tr', null, head.map(c => h('th', c && c.l ? { class: 'l' } : null, typeof c === 'string' ? c : c.label)))));
    const tb = h('tbody');
    rows.forEach((r, i) => {
      const tr = h('tr', rowClass ? { class: rowClass(r, i) || '' } : null);
      for (const c of r) tr.append(h('td', c && c.__td ? c.attrs : null, c && c.__td ? c.nodes : c));
      tb.append(tr);
    });
    t.append(tb);
    return h('div', { class: 'table-scroll' }, t);
  }
  const tdL = nodes => ({ __td: true, attrs: { class: 'l' }, nodes });

  // ---------- 第 2 步：数据核查 ----------
  function renderCheck() {
    const st = App.state, iss = st.issues;
    const items = [];
    const n = sel => App.data[sel].length;
    items.push({ cls: 'ok', ico: '✓', text: `四份数据齐备：抽样框 ${n('frame')} 行 / 抽中 ${n('selected')} 行 / 回答 ${n('responses')} 行 / 人口层 ${n('population')} 行。` });
    items.push(iss.selectedNotInFrame.length === 0
      ? { cls: 'ok', ico: '✓', text: '抽中记录全部能在抽样框中找到。' }
      : { cls: 'bad', ico: '✕', text: `${iss.selectedNotInFrame.length} 条抽中记录不在抽样框中（已剔除）：${iss.selectedNotInFrame.join('、')}` });
    items.push(iss.responsesNotInSelected.length === 0
      ? { cls: 'ok', ico: '✓', text: '回答全部属于抽中名单。' }
      : { cls: 'warn', ico: '⚠', text: `${iss.responsesNotInSelected.length} 条回答不属于抽中名单（无效问卷，已剔除，见下表）。` });
    items.push(iss.duplicateGroups.length === 0
      ? { cls: 'ok', ico: '✓', text: '无重复问卷。' }
      : { cls: 'warn', ico: '⚠', text: `发现 ${iss.duplicateGroups.length} 人重复提交，按「${$('#dup-rule').selectedOptions[0].textContent}」剔除 ${iss.duplicatesRemoved.length} 行（见下表）。` });
    items.push(iss.missingPi.length === 0
      ? { cls: 'ok', ico: '✓', text: '入样概率完整。' }
      : { cls: 'bad', ico: '✕', text: `${iss.missingPi.length} 条抽中记录缺入样概率 → 不可估计（见第 4 步）。` });
    items.push(iss.zeroResponseStrata.length === 0
      ? { cls: 'ok', ico: '✓', text: '每个层都至少有 1 人回答。' }
      : { cls: 'bad', ico: '✕', text: `${iss.zeroResponseStrata.length} 个层无人回答 → 整层不可估计（见第 4 步）。` });
    items.push(iss.missingPopTotals.length === 0
      ? { cls: 'ok', ico: '✓', text: '人口分层总量完整，全部层可校准。' }
      : { cls: 'warn', ico: '⚠', text: `${iss.missingPopTotals.length} 个层缺人口总量，未校准（系数=1，已标注）。` });

    const list = $('#check-list');
    clear(list);
    for (const it of items) {
      list.append(h('div', { class: 'check-item ' + it.cls },
        h('span', { class: 'ico', text: it.ico }),
        h('span', { class: 'detail', text: it.text })));
    }

    // 重复问卷明细
    const dw = $('#dup-table-wrap');
    clear(dw);
    if (iss.duplicatesRemoved.length) {
      dw.append(dataTable('重复问卷处理明细（被剔除的提交）',
        [{ label: 'person_id', l: 1 }, { label: '保留的提交时间', l: 1 }, { label: '剔除的提交时间', l: 1 }],
        iss.duplicatesRemoved.map(d => [tdL(d.person_id), tdL(d.kept_at), tdL(d.removed_at)])));
    }
    const iw = $('#invalid-table-wrap');
    clear(iw);
    if (iss.responsesNotInSelected.length) {
      iw.append(dataTable('无效问卷（不在抽中名单，已剔除）',
        [{ label: 'person_id', l: 1 }, { label: '提交时间', l: 1 }],
        iss.responsesNotInSelected.map(d => [tdL(d.person_id), tdL(d.submitted_at)])));
    }
  }

  // ---------- 第 3 步：权重计算 ----------
  function tile(label, value, sub) {
    return h('div', { class: 'tile' },
      h('div', { class: 't-label', text: label }),
      h('div', { class: 't-value', text: value }),
      sub ? h('div', { class: 't-sub', text: sub }) : null);
  }

  function renderWeights() {
    const st = App.state, P = palette();
    const bases = st.persons.filter(p => p.baseWeight != null).map(p => p.baseWeight).sort((a, b) => a - b);
    const med = W.quantile(bases, 0.5);

    const tiles = $('#wstat-tiles');
    clear(tiles);
    tiles.append(
      tile('抽中记录', fmtInt(st.persons.length), `其中 ${fmtInt(st.persons.filter(p => p.responded).length)} 人回答`),
      tile('基础权重最小', fmtNum(bases[0]), '1 / 最大入样概率'),
      tile('基础权重中位', fmtNum(med)),
      tile('基础权重最大', fmtNum(bases[bases.length - 1]), '1 / 最小入样概率'),
      tile('校准后权重范围', fmtNum(st.weightStats.min) + ' – ' + fmtNum(st.weightStats.max), `中位 ${fmtNum(st.weightStats.median)}`),
      tile('权重变异系数 CV', fmtNum(st.weightStats.cv, 3), '校准后，衡量权重不均衡'),
      tile('校准后权重和', fmtInt(st.weightStats.sumCal), `= 可估计人口 ${fmtInt(st.coverage.popCovered)}`),
    );

    // 非响应调整表
    const nw = $('#nr-table-wrap');
    clear(nw);
    nw.append(dataTable(
      `非响应调整（分组规则：${$('#nr-group').selectedOptions[0].textContent}）`,
      [{ label: '调整组', l: 1 }, '抽中数', '回答数', '回答率', '抽中基础权重和', '回答基础权重和', '调整系数', { label: '状态', l: 1 }],
      st.nrGroups.map(g => [
        tdL(stratumLabel(g.key)),
        fmtInt(g.selected), fmtInt(g.responded),
        g.selected ? fmtPct(g.responded / g.selected) : '—',
        fmtNum(g.sumBaseSel, 1), fmtNum(g.sumBaseResp, 1),
        g.factor == null ? '—' : fmtNum(g.factor, 3),
        tdL(g.estimable
          ? h('span', { class: 'badge ok', text: '✓ 可估计' })
          : h('span', { class: 'badge bad', text: '✕ 整组无回答，不可估计' })),
      ]),
      g => g.estimable ? '' : 'row-dead'));

    // 回答率图
    chartResponseRate($('#chart-resprate'), st.nrGroups);

    // 校准表
    const cw = $('#cal-table-wrap');
    clear(cw);
    cw.append(dataTable('校准（按层对齐人口总量）',
      [{ label: '层', l: 1 }, '人口总量', '回答数', '校准前权重和', '校准系数', '校准后权重和', { label: '状态', l: 1 }],
      st.strata.map(t => [
        tdL(stratumLabel(t.key)),
        t.popTotal == null ? '—' : fmtInt(t.popTotal),
        fmtInt(t.responded),
        t.estimable ? fmtNum(t.sumWNr, 1) : '—',
        t.calFactor == null ? '—' : fmtNum(t.calFactor, 3),
        t.estimable ? fmtNum(t.sumWNr * t.calFactor, 1) : '—',
        tdL(!t.estimable
          ? h('span', { class: 'badge bad', text: '✕ 整层无回答，不可估计' })
          : t.calibrated
            ? h('span', { class: 'badge ok', text: '✓ 已校准' })
            : h('span', { class: 'badge warn', text: '⚠ 缺人口总量，未校准' })),
      ]),
      t => t.estimable ? '' : 'row-dead'));

    // 截尾影响
    const tw = $('#trim-impact');
    clear(tw);
    if (st.config.trimCap != null) {
      const diff = st.weightStats.sumCal - st.weightStats.sumTrim;
      tw.append(
        tile('截尾上限', fmtNum(st.config.trimCap)),
        tile('被截尾记录', fmtInt(st.weightStats.trimmedCount), `占可估计记录 ${fmtPct(st.weightStats.trimmedCount / st.weightStats.n)}`),
        tile('截尾前权重和', fmtInt(st.weightStats.sumCal)),
        tile('截尾后权重和', fmtInt(st.weightStats.sumTrim), `减少 ${fmtInt(diff)}`),
        tile('与可估计人口差额', fmtInt(st.weightStats.sumTrim - st.coverage.popCovered), '截尾后不再重新校准'),
      );
    } else {
      tw.append(tile('截尾', '未启用', '勾选「启用权重截尾」并设上限后此处显示处理影响'));
    }
    chartWeightHist($('#chart-whist'), st);
  }

  // ---------- 第 4 步：不可估计范围 ----------
  function renderNonEstimable() {
    const st = App.state, iss = st.issues, cov = st.coverage;
    const cw = $('#coverage-wrap');
    clear(cw);
    const pct = cov.ratio == null ? '—' : fmtPct(cov.ratio);
    const meter = h('div', { class: 'meter' }, h('div', { style: `width:${(cov.ratio * 100).toFixed(1)}%` }));
    cw.append(
      h('div', { class: 'tile-row' },
        tile('目标总体', fmtInt(cov.popAll), '人口分层总量合计'),
        tile('可估计人口', fmtInt(cov.popCovered), '有回答且可校准的层'),
        tile('总体覆盖率', pct, '加权估计仅代表该范围')),
      meter,
      h('p', { class: 'muted', text: cov.ratio >= 0.999
        ? '所有层均可估计，加权结果代表全部目标总体。'
        : `第 5 步的加权与截尾估计仅代表可估计总体（覆盖率 ${pct}），不外推到下列不可估计范围。` }));

    const rows = [];
    for (const z of iss.zeroResponseStrata) {
      rows.push([
        tdL(z.selected === 0 ? '整层无抽中记录' : '整层无人回答'), tdL(stratumLabel(z.stratum)),
        tdL(z.selected === 0 ? '人口层存在但抽样设计中未覆盖，无法估计' : `抽中 ${z.selected} 人全部未回答，无法计算该层校准系数`),
        z.popTotal == null ? '—' : fmtInt(z.popTotal),
        tdL(h('span', { class: 'badge bad', text: '✕ 从目标总体剔除' }))]);
    }
    for (const m of iss.missingPi) {
      const p = st.persons.find(x => x.id === m.person_id);
      rows.push([
        tdL('缺入样概率'), tdL(m.person_id),
        tdL(`${m.district} · ${m.age_group}；${p && p.responded ? '已回答，但无 π 无法赋权' : '未回答'}`),
        '—',
        tdL(h('span', { class: 'badge bad', text: '✕ 不参与任何估计' }))]);
    }
    for (const m of iss.missingPopTotals) {
      rows.push([
        tdL('缺人口总量'), tdL(stratumLabel(m.stratum)),
        tdL('无法校准，保留非响应调整权重'),
        '—',
        tdL(h('span', { class: 'badge warn', text: '⚠ 未校准' }))]);
    }
    const nw = $('#nonest-wrap');
    clear(nw);
    if (rows.length) {
      nw.append(dataTable('不可估计 / 受限范围清单',
        [{ label: '类型', l: 1 }, { label: '范围', l: 1 }, { label: '说明', l: 1 }, '涉及人口', { label: '处理', l: 1 }],
        rows));
    } else {
      nw.append(h('p', { class: 'muted', text: '没有不可估计的范围。' }));
    }
  }

  // ---------- 第 5 步：估计与区间 ----------
  function ciCell(ind, col) {
    const e = App.estimates[ind.key][col];
    const nodes = [h('div', { text: fmtInd(ind, e.est) })];
    if (App.boot) {
      const ci = App.boot.ci[ind.key][col];
      nodes.push(h('div', { class: 'muted', text: `[${fmtInd(ind, ci.lo)}, ${fmtInd(ind, ci.hi)}]` }));
    }
    return nodes;
  }

  function renderEstimates() {
    const st = App.state;
    const wrap = $('#est-table-wrap');
    clear(wrap);
    const trimNote = st.config.trimCap == null ? '（未启用截尾，同加权列）' : `（上限 ${fmtNum(st.config.trimCap)}）`;
    wrap.append(dataTable(
      `三列对照（均仅基于 ${fmtInt(st.weightStats.n)} 条可估计回答记录）`,
      [{ label: '指标', l: 1 }, { label: '类型', l: 1 }, 'n', '未加权', '加权（校准）', '截尾加权 ' + trimNote],
      W.INDICATORS.map(ind => [
        tdL(ind.label),
        tdL(ind.kind === 'prop' ? '比例' : '均值'),
        fmtInt(App.estimates[ind.key].weighted.n),
        ciCell(ind, 'unweighted'), ciCell(ind, 'weighted'), ciCell(ind, 'trimmed'),
      ])));
    if (App.boot) {
      wrap.append(h('p', { class: 'muted', text: `方括号内为 95% 区间：层内重抽样 B=${App.boot.B}，种子 ${App.boot.seed}（同一种子可完全复现）。` }));
    } else {
      wrap.append(h('p', { class: 'muted', text: '点击「计算 95% 区间」后，各单元格显示重抽样区间。' }));
    }
    chartEstimatePanels($('#chart-estimates'));
  }

  $('#btn-run-boot').addEventListener('click', () => {
    const cfg = readConfig();
    const btn = $('#btn-run-boot');
    btn.disabled = true;
    $('#boot-status').textContent = '计算中…';
    setTimeout(() => {
      App.boot = W.bootstrap(App.state, cfg.seed, cfg.B);
      $('#boot-status').textContent = `完成：B=${App.boot.B}，种子 ${App.boot.seed}。修改分组/截尾等配置后需重新计算。`;
      btn.disabled = false;
      renderEstimates();
    }, 30);
  });

  // ---------- 第 6 步：权重下钻 ----------
  function chainNarrative(p) {
    const st = App.state;
    const lines = [];
    if (p.baseWeight == null) {
      lines.push(`✕ 缺入样概率 π：无法计算基础权重，该记录不参与任何估计。`);
      return lines;
    }
    lines.push(`入样概率 π = ${p.pi} → 基础权重 d = 1/π = ${fmtNum(p.baseWeight, 4)}`);
    const g = st.nrGroups.find(x => x.key === p.nrGroup);
    if (g && g.factor != null) {
      lines.push(`非响应调整：组「${stratumLabel(p.nrGroup)}」抽中基础权重和 ${fmtNum(g.sumBaseSel, 1)} ÷ 回答基础权重和 ${fmtNum(g.sumBaseResp, 1)} = 系数 ${fmtNum(g.factor, 4)} → w₁ = ${fmtNum(p.wNr, 2)}`);
    } else {
      lines.push(`非响应调整：组「${stratumLabel(p.nrGroup)}」无人回答，整组不可估计。`);
      return lines;
    }
    const t = st.strata.find(x => x.key === p.stratum);
    if (!t.estimable) {
      lines.push(`校准：层「${stratumLabel(p.stratum)}」无人回答，整层不可估计。`);
      return lines;
    }
    if (t.calibrated) {
      lines.push(`校准：层人口 ${fmtInt(t.popTotal)} ÷ 层内 w₁ 权重和 ${fmtNum(t.sumWNr, 1)} = 系数 ${fmtNum(t.calFactor, 4)} → w₂ = ${fmtNum(p.wCal, 2)}`);
    } else {
      lines.push(`校准：该层缺人口总量，未校准（系数 1）→ w₂ = ${fmtNum(p.wCal, 2)}`);
    }
    if (!p.responded) {
      lines.push(`该记录未回答：不进入点估计；其基础权重已通过非响应调整分摊给同组回答者。`);
      return lines;
    }
    if (st.config.trimCap != null) {
      lines.push(p.wCal > st.config.trimCap
        ? `截尾：w₂ ${fmtNum(p.wCal, 2)} 超过上限 ${fmtNum(st.config.trimCap)} → w₃ = ${fmtNum(p.wTrim, 2)}（被截尾）`
        : `截尾：w₂ ${fmtNum(p.wCal, 2)} 未超上限 ${fmtNum(st.config.trimCap)} → w₃ = ${fmtNum(p.wTrim, 2)}（不变）`);
    } else {
      lines.push(`截尾：未启用 → w₃ = w₂ = ${fmtNum(p.wTrim, 2)}`);
    }
    return lines;
  }

  function renderDrilldown() {
    const st = App.state;
    const wrap = $('#drill-table-wrap');
    clear(wrap);
    const q = ($('#drill-search').value || '').trim().toLowerCase();
    const persons = st.persons.filter(p => !q || p.id.toLowerCase().includes(q));
    const head = ['', { label: 'person_id', l: 1 }, { label: '区', l: 1 }, { label: '年龄段', l: 1 }, 'π', '基础权重', '非响应系数', '校准系数', '校准后权重', '截尾后权重', { label: '状态', l: 1 }];
    const t = h('table', { class: 'data' });
    t.append(h('thead', null, h('tr', null, head.map(c => h('th', c && c.l ? { class: 'l' } : null, typeof c === 'string' ? c : c.label)))));
    const tb = h('tbody');
    for (const p of persons) {
      const btn = h('button', { class: 'drill-toggle', type: 'button', text: '＋', 'aria-label': '展开权重来由' });
      const tr = h('tr', p.estimable ? null : { class: 'row-flagged' },
        h('td', null, btn),
        h('td', { class: 'l', text: p.id }),
        h('td', { class: 'l', text: p.district }),
        h('td', { class: 'l', text: p.ageGroup }),
        h('td', { text: p.pi == null ? '缺失' : String(p.pi) }),
        h('td', { text: fmtNum(p.baseWeight) }),
        h('td', { text: p.nrFactor == null ? '—' : fmtNum(p.nrFactor, 3) }),
        h('td', { text: p.calFactor == null ? '—' : fmtNum(p.calFactor, 3) }),
        h('td', { text: p.responded && p.wCal != null ? fmtNum(p.wCal, 1) : '—' }),
        h('td', { text: p.responded && p.wTrim != null ? fmtNum(p.wTrim, 1) : '—' }),
        h('td', { class: 'l' }, p.flags.length
          ? h('span', { class: 'badge warn', text: '⚠ ' + p.flags.join('；') })
          : h('span', { class: 'badge ok', text: '✓ 可估计' })));
      const detailTr = h('tr', { hidden: '' },
        h('td', { colspan: '11' },
          h('div', { class: 'drill-detail' },
            chainNarrative(p).map(line => h('div', { class: 'chain', text: line })))));
      btn.addEventListener('click', () => {
        const open = detailTr.hasAttribute('hidden');
        if (open) { detailTr.removeAttribute('hidden'); btn.textContent = '－'; }
        else { detailTr.setAttribute('hidden', ''); btn.textContent = '＋'; }
      });
      tb.append(tr, detailTr);
    }
    t.append(tb);
    wrap.append(h('div', { class: 'table-scroll' }, t));
    wrap.append(h('p', { class: 'muted', text: `共 ${fmtInt(persons.length)} 条抽中记录${q ? `（筛选：${q}）` : ''}。点击「＋」查看该记录每一步权重的来由。` }));
  }
  $('#drill-search').addEventListener('input', renderDrilldown);

  // ---------- 图表 ----------
  function hbarPath(x, y, w, hgt, r) { // 左方右圆
    r = Math.max(0, Math.min(r, w, hgt / 2));
    return `M${x},${y} h${Math.max(0, w - r)} a${r},${r} 0 0 1 ${r},${r} v${Math.max(0, hgt - 2 * r)} a${r},${r} 0 0 1 ${-r},${r} h${-Math.max(0, w - r)} z`;
  }
  function vbarPath(x, y, w, hgt, r) { // 上圆下方（y 为顶端）
    r = Math.max(0, Math.min(r, w / 2, hgt));
    return `M${x},${y + hgt} v${-Math.max(0, hgt - r)} a${r},${r} 0 0 1 ${r},${-r} h${Math.max(0, w - 2 * r)} a${r},${r} 0 0 1 ${r},${r} v${Math.max(0, hgt - r)} z`;
  }
  function axisText(x, y, str, anchor) {
    return s('text', { x, y, 'text-anchor': anchor || 'middle', class: 'axis-text' }, str);
  }

  // 各调整组回答率（单系列 → 单 hue，无图例；仅标注最低两组）
  function chartResponseRate(container, groups) {
    clear(container);
    const P = palette();
    const rows = groups.map(g => ({ key: g.key, rate: g.selected ? g.responded / g.selected : 0, g }))
      .sort((a, b) => a.rate - b.rate);
    const Wd = 760, rowH = 30, padL = 170, padR = 56, padT = 6, padB = 26;
    const H = padT + rows.length * rowH + padB;
    const x = v => padL + (Wd - padL - padR) * v;
    const svg = s('svg', { viewBox: `0 0 ${Wd} ${H}`, width: '100%', role: 'img', 'aria-label': '各调整组回答率条形图' });
    for (const v of [0, 0.25, 0.5, 0.75, 1]) {
      svg.append(s('line', { x1: x(v), y1: padT, x2: x(v), y2: H - padB, stroke: P.grid, 'stroke-width': 1 }));
      svg.append(axisText(x(v), H - 8, fmtPct(v, 0)));
    }
    rows.forEach((r, i) => {
      const y = padT + i * rowH + (rowH - 20) / 2;
      const g = s('g', { class: 'bar', tabindex: '0' });
      g.append(s('path', { d: hbarPath(x(0), y, Math.max(1.5, x(r.rate) - x(0)), 20, 4), fill: P.s1, class: 'mark' }));
      g.append(s('rect', { x: padL, y: padT + i * rowH, width: Wd - padL - padR, height: rowH, class: 'bar-hit' }));
      bindTip(g, stratumLabel(r.key), [
        { color: P.s1, value: fmtPct(r.rate), name: '回答率' },
        { value: `${r.g.responded} / ${r.g.selected}`, name: '回答 / 抽中' },
      ]);
      svg.append(g);
      svg.append(s('text', { x: padL - 8, y: y + 14, 'text-anchor': 'end', 'font-size': 12, fill: P.secondary }, stratumLabel(r.key)));
      if (i < 2) { // 仅标注回答率最低的两组（非响应集中之处）
        svg.append(s('text', { x: x(r.rate) + 8, y: y + 14, 'font-size': 12, 'font-weight': 600, fill: P.text }, fmtPct(r.rate)));
      }
    });
    container.append(svg);
  }

  // 权重分布直方图（校准后；启用截尾时叠加截尾后，双系列带图例）
  function chartWeightHist(container, st) {
    clear(container);
    const P = palette();
    const persons = st.persons.filter(p => p.estimable);
    const trimOn = st.config.trimCap != null;
    const series = [{ name: '校准后权重', color: P.s1, vals: persons.map(p => p.wCal) }];
    if (trimOn) series.push({ name: '截尾后权重', color: P.s2, vals: persons.map(p => p.wTrim) });
    const all = series.flatMap(sr => sr.vals);
    const lo = Math.floor(Math.min(...all)), hi = Math.ceil(Math.max(...all));
    const BINS = 12, bw = (hi - lo) / BINS || 1;
    const counts = series.map(sr => {
      const c = new Array(BINS).fill(0);
      for (const v of sr.vals) c[Math.min(BINS - 1, Math.floor((v - lo) / bw))]++;
      return c;
    });
    const maxC = Math.max(...counts.flat());
    const Wd = 760, padL = 44, padR = 10, padT = 10, padB = 40, H = 240;
    const y = v => padT + (H - padT - padB) * (1 - v / maxC);
    const slotW = (Wd - padL - padR) / BINS;
    const barW = Math.min(22, (slotW - 2 * (series.length + 1)) / series.length);
    const svg = s('svg', { viewBox: `0 0 ${Wd} ${H}`, width: '100%', role: 'img', 'aria-label': '权重分布直方图' });
    for (const v of [0, Math.ceil(maxC / 2), maxC]) {
      svg.append(s('line', { x1: padL, y1: y(v), x2: Wd - padR, y2: y(v), stroke: P.grid, 'stroke-width': 1 }));
      svg.append(axisText(padL - 6, y(v) + 4, String(v), 'end'));
    }
    counts.forEach((c, si) => {
      for (let b = 0; b < BINS; b++) {
        if (!c[b]) continue;
        const bx = padL + b * slotW + (slotW - barW * series.length - 2 * (series.length - 1)) / 2 + si * (barW + 2);
        const by = y(c[b]);
        const g = s('g', { class: 'bar', tabindex: '0' });
        g.append(s('path', { d: vbarPath(bx, by, barW, H - padB - by, 3), fill: series[si].color, class: 'mark' }));
        g.append(s('rect', { x: padL + b * slotW, y: padT, width: slotW, height: H - padT - padB, class: 'bar-hit' }));
        bindTip(g, `权重 ${fmtNum(lo + b * bw, 0)} – ${fmtNum(lo + (b + 1) * bw, 0)}`,
          series.map((sr, k) => ({ color: sr.color, value: fmtInt(counts[k][b]) + ' 条', name: sr.name })));
        svg.append(g);
      }
    });
    for (let b = 0; b <= BINS; b += 3) {
      svg.append(axisText(padL + b * slotW, H - 24, fmtInt(lo + b * bw)));
    }
    svg.append(axisText(padL + (Wd - padL - padR) / 2, H - 6, '权重值'));
    container.append(svg);
    if (series.length > 1) {
      container.append(h('div', { class: 'legend' }, series.map(sr =>
        h('span', { class: 'lg' }, h('span', { class: 'sw', style: 'background:' + sr.color }), sr.name))));
    }
  }

  // 三列估计对照（每指标一个小图；区间须线）
  function chartEstimatePanels(container) {
    clear(container);
    const P = palette();
    const cols = [
      { key: 'unweighted', name: '未加权', color: P.s1 },
      { key: 'weighted', name: '加权（校准）', color: P.s2 },
      { key: 'trimmed', name: '截尾加权', color: P.s3 },
    ];
    container.append(h('div', { class: 'legend' }, cols.map(c =>
      h('span', { class: 'lg' }, h('span', { class: 'sw', style: 'background:' + c.color }), c.name))));
    const grid = h('div', { class: 'est-panels' });
    for (const ind of W.INDICATORS) {
      const vals = cols.map(c => App.estimates[ind.key][c.key].est);
      const his = App.boot ? cols.map(c => App.boot.ci[ind.key][c.key].hi) : [];
      const vmax = Math.max(...vals, ...his) * 1.18 || 1;
      const Wd = 250, padL = 8, padR = 8, padT = 20, padB = 34, H = 190;
      const y = v => padT + (H - padT - padB) * (1 - v / vmax);
      const slotW = (Wd - padL - padR) / 3;
      const barW = Math.min(24, slotW * 0.55);
      const svg = s('svg', { viewBox: `0 0 ${Wd} ${H}`, width: '100%', role: 'img', 'aria-label': ind.label + '三列对照' });
      svg.append(s('line', { x1: padL, y1: y(0), x2: Wd - padR, y2: y(0), stroke: P.baseline, 'stroke-width': 1 }));
      cols.forEach((c, i) => {
        const v = vals[i];
        const cx = padL + i * slotW + slotW / 2;
        const g = s('g', { class: 'bar', tabindex: '0' });
        g.append(s('path', { d: vbarPath(cx - barW / 2, y(v), barW, H - padB - y(v), 4), fill: c.color, class: 'mark' }));
        if (App.boot) {
          const ci = App.boot.ci[ind.key][c.key];
          g.append(s('line', { x1: cx, y1: y(ci.lo), x2: cx, y2: y(ci.hi), stroke: P.secondary, 'stroke-width': 2 }));
          g.append(s('line', { x1: cx - 5, y1: y(ci.lo), x2: cx + 5, y2: y(ci.lo), stroke: P.secondary, 'stroke-width': 2 }));
          g.append(s('line', { x1: cx - 5, y1: y(ci.hi), x2: cx + 5, y2: y(ci.hi), stroke: P.secondary, 'stroke-width': 2 }));
        }
        g.append(s('rect', { x: padL + i * slotW, y: padT, width: slotW, height: H - padT - padB, class: 'bar-hit' }));
        bindTip(g, ind.label + ' · ' + c.name, App.boot
          ? [{ color: c.color, value: fmtInd(ind, v), name: '点估计' },
             { value: `[${fmtInd(ind, App.boot.ci[ind.key][c.key].lo)}, ${fmtInd(ind, App.boot.ci[ind.key][c.key].hi)}]`, name: '95% 区间' }]
          : [{ color: c.color, value: fmtInd(ind, v), name: '点估计' }]);
        svg.append(g);
        svg.append(s('text', { x: cx, y: y(v) - 6, 'text-anchor': 'middle', 'font-size': 11, 'font-weight': 600, fill: P.text }, fmtInd(ind, v)));
        svg.append(s('text', { x: cx, y: H - 18, 'text-anchor': 'middle', 'font-size': 11, fill: P.secondary }, c.name.replace('（校准）', '')));
      });
      const n = App.estimates[ind.key].weighted.n;
      grid.append(h('div', { class: 'est-panel' },
        h('h4', { text: ind.label }),
        h('div', { class: 'panel-sub', text: `${ind.kind === 'prop' ? '比例' : '均值'} · n=${fmtInt(n)}` }),
        svg));
    }
    container.append(grid);
  }

  // ---------- 第 7 步：导出 ----------
  function download(filename, text, mime) {
    const blob = new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' });
    const a = h('a', { href: URL.createObjectURL(blob), download: filename });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    $('#export-status').textContent = `已导出 ${filename}（${new Date().toLocaleTimeString('zh-CN')}）`;
  }
  const stamp = () => new Date().toISOString().slice(0, 10);

  $('#btn-exp-weights').addEventListener('click', () => {
    const st = App.state;
    const rows = st.persons.map(p => ({
      person_id: p.id, district: p.district, age_group: p.ageGroup,
      responded: p.responded ? 1 : 0,
      pi: p.pi == null ? '' : p.pi,
      base_weight: p.baseWeight == null ? '' : p.baseWeight.toFixed(6),
      nr_group: stratumLabel(p.nrGroup),
      nr_factor: p.nrFactor == null ? '' : p.nrFactor.toFixed(6),
      cal_factor: p.calFactor == null ? '' : p.calFactor.toFixed(6),
      w_nr: p.wNr == null ? '' : p.wNr.toFixed(4),
      w_calibrated: p.responded && p.wCal != null ? p.wCal.toFixed(4) : '',
      w_trimmed: p.responded && p.wTrim != null ? p.wTrim.toFixed(4) : '',
      estimable: p.estimable ? 1 : 0,
      flags: p.flags.join(';'),
    }));
    download(`权重明细-${stamp()}.csv`, '﻿' + W.toCSV(rows, [
      { key: 'person_id', label: 'person_id' }, { key: 'district', label: 'district' }, { key: 'age_group', label: 'age_group' },
      { key: 'responded', label: 'responded' }, { key: 'pi', label: 'pi' }, { key: 'base_weight', label: 'base_weight' },
      { key: 'nr_group', label: 'nr_group' }, { key: 'nr_factor', label: 'nr_factor' },
      { key: 'cal_factor', label: 'cal_factor' }, { key: 'w_nr', label: 'w_nr' },
      { key: 'w_calibrated', label: 'w_calibrated' }, { key: 'w_trimmed', label: 'w_trimmed' },
      { key: 'estimable', label: 'estimable' }, { key: 'flags', label: 'flags' },
    ]), 'text/csv');
  });

  $('#btn-exp-est').addEventListener('click', () => {
    const rows = W.INDICATORS.map(ind => {
      const e = App.estimates[ind.key];
      const r = {
        indicator: ind.label, type: ind.kind === 'prop' ? '比例' : '均值', n: e.weighted.n,
        unweighted: e.unweighted.est, weighted: e.weighted.est, trimmed: e.trimmed.est,
      };
      if (App.boot) for (const c of ['unweighted', 'weighted', 'trimmed']) {
        r[c + '_lo'] = App.boot.ci[ind.key][c].lo;
        r[c + '_hi'] = App.boot.ci[ind.key][c].hi;
      }
      r.seed = App.boot ? App.boot.seed : '';
      r.B = App.boot ? App.boot.B : '';
      return r;
    });
    const cols = [
      { key: 'indicator', label: 'indicator' }, { key: 'type', label: 'type' }, { key: 'n', label: 'n' },
      { key: 'unweighted', label: 'unweighted' }, { key: 'weighted', label: 'weighted' }, { key: 'trimmed', label: 'trimmed' },
      { key: 'unweighted_lo', label: 'unweighted_ci_lo' }, { key: 'unweighted_hi', label: 'unweighted_ci_hi' },
      { key: 'weighted_lo', label: 'weighted_ci_lo' }, { key: 'weighted_hi', label: 'weighted_ci_hi' },
      { key: 'trimmed_lo', label: 'trimmed_ci_lo' }, { key: 'trimmed_hi', label: 'trimmed_ci_hi' },
      { key: 'seed', label: 'seed' }, { key: 'B', label: 'B' },
    ];
    download(`估计结果-${stamp()}.csv`, '﻿' + W.toCSV(rows, cols), 'text/csv');
  });

  $('#btn-exp-nonest').addEventListener('click', () => {
    const iss = App.state.issues;
    const rows = [];
    for (const z of iss.zeroResponseStrata) rows.push({ type: z.selected === 0 ? '整层无抽中记录' : '整层无人回答', scope: stratumLabel(z.stratum), detail: z.selected === 0 ? '人口层未被抽样设计覆盖' : `抽中${z.selected}人全部未回答`, pop_affected: z.popTotal == null ? '' : z.popTotal });
    for (const m of iss.missingPi) rows.push({ type: '缺入样概率', scope: m.person_id, detail: `${m.district}·${m.age_group}`, pop_affected: '' });
    for (const m of iss.missingPopTotals) rows.push({ type: '缺人口总量', scope: stratumLabel(m.stratum), detail: '未校准', pop_affected: '' });
    download(`不可估计清单-${stamp()}.csv`, '﻿' + W.toCSV(rows, [
      { key: 'type', label: 'type' }, { key: 'scope', label: 'scope' }, { key: 'detail', label: 'detail' }, { key: 'pop_affected', label: 'pop_affected' },
    ]), 'text/csv');
  });

  $('#btn-exp-report').addEventListener('click', () => {
    const st = App.state;
    const report = {
      generated_at: new Date().toISOString(),
      note: '虚构数据演示；全部计算在本地浏览器完成，未连接任何真实调查平台。',
      config: { ...st.config, seed: App.boot ? App.boot.seed : null, B: App.boot ? App.boot.B : null },
      counts: {
        frame: App.data.frame.length, selected: App.data.selected.length,
        response_rows: App.data.responses.length,
        respondents_estimable: st.weightStats.n,
      },
      coverage: st.coverage,
      issues: st.issues,
      nrGroups: st.nrGroups, strata: st.strata, weightStats: st.weightStats,
      estimates: App.estimates,
      bootstrap: App.boot ? { seed: App.boot.seed, B: App.boot.B, ci: App.boot.ci } : null,
    };
    download(`分析报告-${stamp()}.json`, JSON.stringify(report, null, 2), 'application/json');
  });

  // 方法说明（弹层 HTML 与导出 Markdown 共用要点，修改时请同步）
  const METHOD_MD = `# 方法说明：居民调查加权分析

## 数据与范围
- 全部数据为虚构示例或用户自行导入的 CSV/JSON；页面纯本地运行，不连接任何真实调查平台。
- 三列估计（未加权 / 加权 / 截尾）均仅基于「可估计记录」：有有效回答且入样概率 π 有效的抽中记录，保证三列可比。

## 权重计算链（逐记录可下钻）
1. **基础权重** d_i = 1/π_i。π 缺失 → 该记录不可估计，不参与任何估计。
2. **非响应调整** 按所选分组 g（层 或 区）：f_g = 组内抽中基础权重和 ÷ 组内回答基础权重和；w1_i = d_i × f_g。整组无人回答 → 该组不可估计。
3. **校准** 按层 s 对齐人口总量：c_s = 层人口总量 ÷ 层内回答者 w1 权重和；w2_i = w1_i × c_s。整层无人回答 → 该层不可估计，其人口从目标总体剔除并计入覆盖率；缺人口总量的层不校准（系数=1）并标注。
4. **截尾（可选）** w3_i = min(w2_i, cap)。页面显示被截尾记录数与权重和变化；截尾后不再重新校准，权重和与人口总量的差额在页面与导出中明示。

## 点估计
比例与均值均为比率估计 Σw·y / Σw：未加权列 w=1；加权列 w=w2；截尾列 w=w3。项目级缺失（如收入未填）按指标分别剔除并显示各自 n。

## 区间估计（重抽样）
层内非参数 bootstrap：每次在各可估计层内对回答者有放回抽取与原层相同数量的记录；非响应调整系数沿用全样本值；校准系数与截尾在每次重抽样内重新计算；取 B 次估计的 2.5% 与 97.5% 百分位为 95% 区间。随机数发生器 mulberry32，种子固定（默认 20261115），同一种子结果完全可复现。

## 已知局限
- 未包含多阶段/整群设计的设计效应；区间仅反映回答者层面的抽样与校准不确定性。
- 非响应调整假设组内随机缺失（MAR）。
- 整层无回答时任何加权方法都无法无偏代表该层，本工具选择明示不可估计范围，而非硬算出一个看似可信的数。
`;
  $('#btn-exp-method').addEventListener('click', () => download(`方法说明-${stamp()}.md`, METHOD_MD, 'text/markdown'));

  // 方法说明弹层
  const METHOD_HTML = [
    ['数据与范围', '全部数据为虚构示例或用户自行导入的文件；页面纯本地运行，不连接任何真实调查平台。三列估计（未加权/加权/截尾）均仅基于可估计记录（有回答且 π 有效），保证可比。'],
    ['权重计算链', '基础权重 d=1/π → 非响应调整（组内抽中权重和÷回答权重和）→ 校准（层人口总量÷层内权重和）→ 可选截尾。每条记录的完整链条可在第 6 步下钻。'],
    ['不可估计规则', '缺 π 的记录、整层（或整组）无人回答的层不硬算：从加权目标总体中剔除并列入第 4 步清单，同时给出总体覆盖率。缺人口总量的层不校准并标注。'],
    ['区间估计', '层内非参数 bootstrap：层内有放回重抽样，非响应系数沿用全样本，校准与截尾每次重算，取 2.5%/97.5% 百分位。种子固定（mulberry32，默认 20261115），结果可复现。'],
    ['局限', '未含整群/多阶段设计效应；非响应调整假设组内 MAR；截尾后不再重新校准。'],
  ];
  const mc = $('#method-content');
  for (const [t, body] of METHOD_HTML) mc.append(h('h3', { text: t }), h('p', { text: body }));
  $('#btn-method').addEventListener('click', () => { $('#method-modal').hidden = false; });
  $('#btn-method-close').addEventListener('click', () => { $('#method-modal').hidden = true; });
  $('#method-modal').addEventListener('click', e => { if (e.target.id === 'method-modal') e.target.hidden = true; });

  // ---------- 启动 ----------
  renderDatasets();
  recompute();
})();
