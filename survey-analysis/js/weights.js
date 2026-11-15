/**
 * 调查加权核心计算模块（纯函数，无 DOM 依赖；浏览器与 Node 双端可用）
 *
 * 计算链（每条记录可下钻）：
 *   基础权重   d_i = 1 / pi_i                      （pi 为入样概率）
 *   非响应调整 w1_i = d_i × f_g，f_g = 组内抽中权重和 / 组内回答权重和
 *   校准       w2_i = w1_i × c_s，c_s = 层人口总量 / 层内回答者 w1 权重和
 *   截尾       w3_i = min(w2_i, cap)               （可选，页面设上限）
 *
 * 不可估计规则（不硬算）：
 *   - 缺少入样概率的记录：不参与任何加权估计，列入不可估计清单
 *   - 整层无人回答的层：该层人口无法被代表，从加权估计的目标总体中剔除并明示
 *   - 缺少人口总量的层：无法校准，保留非响应调整权重并明确标注"未校准"
 *
 * 区间估计：分层有放回重抽样（层内 bootstrap）。
 *   每次重抽样在可估计层内对回答者重新抽样，非响应调整系数沿用全样本值，
 *   校准系数与截尾在每次重抽样内重新计算；取 B 次估计的 2.5%/97.5% 百分位。
 *   随机种子固定（mulberry32），同一种子结果完全可复现。
 */
(function (global) {
  'use strict';

  // ---------- 确定性随机数 ----------
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------- CSV 解析（支持引号、转义、\r\n、BOM）----------
  function parseCSV(text) {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const rows = [];
    let row = [], field = '', inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += c;
      } else if (c === '"') {
        inQuotes = true;
      } else if (c === ',') {
        row.push(field); field = '';
      } else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        if (row.length > 1 || row[0] !== '') rows.push(row);
        row = [];
      } else field += c;
    }
    if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
    if (rows.length === 0) return [];
    const header = rows[0].map(h => h.trim());
    return rows.slice(1).map(r => {
      const obj = {};
      header.forEach((h, j) => { obj[h] = (r[j] === undefined ? '' : r[j]).trim(); });
      return obj;
    });
  }

  function toCSV(rows, cols) {
    const esc = v => {
      v = v === null || v === undefined ? '' : String(v);
      return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    };
    const lines = [cols.map(c => esc(c.label)).join(',')];
    for (const r of rows) lines.push(cols.map(c => esc(r[c.key])).join(','));
    return lines.join('\n');
  }

  // ---------- 指标定义（回答结果 → 数值）----------
  const INDICATORS = [
    {
      key: 'satisfied', label: '对生活状况满意的比例', kind: 'prop', fmt: 'pct',
      value: r => r.satisfied === '满意' ? 1 : (r.satisfied === '不满意' ? 0 : null),
    },
    {
      key: 'community', label: '近一年参与社区活动的比例', kind: 'prop', fmt: 'pct',
      value: r => r.community === '参与' ? 1 : (r.community === '未参与' ? 0 : null),
    },
    {
      key: 'exercise', label: '每周运动时长（小时）', kind: 'mean', fmt: 'num1',
      value: r => r.exercise_hours === '' || r.exercise_hours == null ? null : (isFinite(+r.exercise_hours) ? +r.exercise_hours : null),
    },
    {
      key: 'income', label: '月人均可支配收入（元）', kind: 'mean', fmt: 'int',
      value: r => r.monthly_income === '' || r.monthly_income == null ? null : (isFinite(+r.monthly_income) ? +r.monthly_income : null),
    },
  ];

  function stratumKey(district, ageGroup) { return district + '|' + ageGroup; }

  // ---------- 重复问卷处理 ----------
  // rule: 'latest' 保留最新提交（默认）| 'earliest' 保留最早提交
  function dedupeResponses(responseRows, rule) {
    const byId = new Map();
    for (const r of responseRows) {
      if (!byId.has(r.person_id)) byId.set(r.person_id, []);
      byId.get(r.person_id).push(r);
    }
    const kept = new Map();
    const removed = [];
    const duplicateGroups = [];
    for (const [id, list] of byId) {
      if (list.length === 1) { kept.set(id, list[0]); continue; }
      const sorted = list.slice().sort((a, b) => a.submitted_at < b.submitted_at ? -1 : a.submitted_at > b.submitted_at ? 1 : 0);
      const keep = rule === 'earliest' ? sorted[0] : sorted[sorted.length - 1];
      kept.set(id, keep);
      const dropped = sorted.filter(x => x !== keep);
      for (const d of dropped) removed.push({ person_id: id, kept_at: keep.submitted_at, removed_at: d.submitted_at });
      duplicateGroups.push({ person_id: id, count: list.length, kept_at: keep.submitted_at });
    }
    return { kept, removed, duplicateGroups };
  }

  // ---------- 主管线 ----------
  // data: {frame, selected, responses, population}（均为对象数组）
  // config: {dupRule, nrGroup: 'stratum'|'district', trimCap: number|null}
  function computePipeline(data, config) {
    const cfg = Object.assign({ dupRule: 'latest', nrGroup: 'stratum', trimCap: null }, config);
    const issues = {
      selectedNotInFrame: [],   // 抽中记录不在抽样框中
      responsesNotInSelected: [], // 回答不属于抽中名单（无效问卷）
      duplicatesRemoved: [],    // 被剔除的重复问卷
      duplicateGroups: [],
      missingPi: [],            // 缺入样概率的抽中记录
      zeroResponseStrata: [],   // 整层无人回答
      missingPopTotals: [],     // 缺人口总量的层（未校准）
    };

    const frameById = new Map(data.frame.map(r => [r.person_id, r]));
    const selectedIds = new Set(data.selected.map(r => r.person_id));

    // 校验 1：抽中记录应在抽样框中
    for (const s of data.selected) {
      if (!frameById.has(s.person_id)) issues.selectedNotInFrame.push(s.person_id);
    }
    // 校验 2：回答应属于抽中名单（对原始回答逐行检查，含重复行）
    const invalidResponseRows = data.responses.filter(r => !selectedIds.has(r.person_id));
    issues.responsesNotInSelected = invalidResponseRows.map(r => ({ person_id: r.person_id, submitted_at: r.submitted_at }));
    const validResponseRows = data.responses.filter(r => selectedIds.has(r.person_id));

    // 重复问卷
    const dedup = dedupeResponses(validResponseRows, cfg.dupRule);
    issues.duplicatesRemoved = dedup.removed;
    issues.duplicateGroups = dedup.duplicateGroups;

    // 人口总量索引
    const popByStratum = new Map();
    for (const p of data.population) {
      popByStratum.set(stratumKey(p.district, p.age_group), +p.pop_total);
    }

    // 逐抽中记录构建
    const persons = [];
    for (const s of data.selected) {
      const f = frameById.get(s.person_id);
      if (!f) continue; // 已计入 selectedNotInFrame
      const pi = s.pi === '' || s.pi == null ? NaN : +s.pi;
      const hasPi = isFinite(pi) && pi > 0 && pi <= 1;
      if (!hasPi) issues.missingPi.push({ person_id: s.person_id, district: f.district, age_group: f.age_group });
      const resp = dedup.kept.get(s.person_id) || null;
      persons.push({
        id: s.person_id,
        district: f.district,
        ageGroup: f.age_group,
        stratum: stratumKey(f.district, f.age_group),
        pi: hasPi ? pi : null,
        baseWeight: hasPi ? 1 / pi : null,
        responded: !!resp,
        response: resp,
        nrGroup: null, nrFactor: null,
        calFactor: null, wNr: null, wCal: null, wTrim: null,
        estimable: false, // 可参与加权估计
        flags: [],
      });
    }

    // 非响应调整分组
    const groupKeyOf = p => cfg.nrGroup === 'district' ? p.district : p.stratum;
    const groupMap = new Map();
    for (const p of persons) {
      const k = groupKeyOf(p);
      if (!groupMap.has(k)) groupMap.set(k, { key: k, selected: 0, responded: 0, sumBaseSel: 0, sumBaseResp: 0, factor: null, estimable: false });
      const g = groupMap.get(k);
      g.selected++;
      if (p.responded) g.responded++;
      if (p.baseWeight != null) {
        g.sumBaseSel += p.baseWeight;
        if (p.responded) g.sumBaseResp += p.baseWeight;
      }
    }
    const nrGroups = [...groupMap.values()];
    for (const g of nrGroups) {
      g.estimable = g.sumBaseResp > 0;
      g.factor = g.estimable ? g.sumBaseSel / g.sumBaseResp : null;
    }
    for (const p of persons) {
      p.nrGroup = groupKeyOf(p);
      const g = groupMap.get(p.nrGroup);
      p.nrFactor = g.factor;
      if (p.baseWeight != null && g.factor != null) p.wNr = p.baseWeight * g.factor;
    }

    // 校准（按层）
    const strataMap = new Map();
    for (const p of persons) {
      if (!strataMap.has(p.stratum)) {
        strataMap.set(p.stratum, {
          key: p.stratum, district: p.district, ageGroup: p.ageGroup,
          popTotal: popByStratum.has(p.stratum) ? popByStratum.get(p.stratum) : null,
          selected: 0, responded: 0, sumWNr: 0, calFactor: null, estimable: false, calibrated: false,
        });
      }
      const st = strataMap.get(p.stratum);
      st.selected++;
      if (p.responded) st.responded++;
      if (p.wNr != null && p.responded) st.sumWNr += p.wNr;
    }
    const strata = [...strataMap.values()];
    // 人口总量中存在、但没有任何抽中记录的层：同样不可估计，须计入覆盖率分母
    for (const [key, pop] of popByStratum) {
      if (!strataMap.has(key)) {
        const [district, ageGroup] = key.split('|');
        strata.push({
          key, district, ageGroup, popTotal: pop,
          selected: 0, responded: 0, sumWNr: 0, calFactor: null, estimable: false, calibrated: false,
        });
      }
    }
    for (const st of strata) {
      st.estimable = st.responded > 0 && st.sumWNr > 0;
      if (!st.estimable) {
        issues.zeroResponseStrata.push({ stratum: st.key, district: st.district, ageGroup: st.ageGroup, selected: st.selected, popTotal: st.popTotal });
        continue;
      }
      if (st.popTotal == null || !(st.popTotal > 0)) {
        st.calFactor = 1;
        issues.missingPopTotals.push({ stratum: st.key, district: st.district, ageGroup: st.ageGroup });
      } else {
        st.calFactor = st.popTotal / st.sumWNr;
        st.calibrated = true;
      }
    }
    for (const p of persons) {
      const st = strataMap.get(p.stratum);
      p.calFactor = st.calFactor;
      if (p.wNr != null && st.calFactor != null) p.wCal = p.wNr * st.calFactor;
      p.estimable = p.responded && p.wCal != null;
      if (p.estimable) p.wTrim = cfg.trimCap != null ? Math.min(p.wCal, cfg.trimCap) : p.wCal;
      if (!p.responded) p.flags.push('未回答');
      if (p.baseWeight == null) p.flags.push('缺入样概率');
      if (!st.estimable) p.flags.push('整层无回答');
      if (st.estimable && !st.calibrated) p.flags.push('未校准(缺人口总量)');
    }

    // 总体覆盖率
    let popAll = 0, popCovered = 0;
    for (const st of strata) {
      if (st.popTotal != null) {
        popAll += st.popTotal;
        if (st.estimable) popCovered += st.popTotal;
      }
    }
    const coverage = { popAll, popCovered, ratio: popAll > 0 ? popCovered / popAll : null };

    // 权重摘要
    const wCals = persons.filter(p => p.estimable).map(p => p.wCal).sort((a, b) => a - b);
    const wTrims = persons.filter(p => p.estimable).map(p => p.wTrim);
    const median = arr => arr.length ? (arr.length % 2 ? arr[(arr.length - 1) / 2] : (arr[arr.length / 2 - 1] + arr[arr.length / 2]) / 2) : null;
    const mean = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
    const m = mean(wCals);
    const cv = wCals.length ? Math.sqrt(wCals.reduce((a, b) => a + (b - m) * (b - m), 0) / wCals.length) / m : null;
    const weightStats = {
      n: wCals.length,
      min: wCals[0] ?? null, median: median(wCals), max: wCals[wCals.length - 1] ?? null,
      cv,
      sumCal: wCals.reduce((a, b) => a + b, 0),
      sumTrim: wTrims.reduce((a, b) => a + b, 0),
      trimmedCount: cfg.trimCap != null ? wCals.filter(w => w > cfg.trimCap).length : 0,
    };

    return { config: cfg, persons, nrGroups, strata, issues, coverage, weightStats };
  }

  // ---------- 点估计 ----------
  // weightKind: 'unweighted' | 'weighted' | 'trimmed'
  function weightOf(p, kind) {
    if (kind === 'unweighted') return 1;
    if (kind === 'weighted') return p.wCal;
    return p.wTrim;
  }

  function estimateOne(persons, indicator, weightKind) {
    let sumW = 0, sumWY = 0, n = 0;
    for (const p of persons) {
      if (!p.estimable) continue;
      const v = indicator.value(p.response);
      if (v == null) continue;
      const w = weightOf(p, weightKind);
      sumW += w; sumWY += w * v; n++;
    }
    return sumW > 0 ? { n, est: sumWY / sumW, sumW } : { n: 0, est: null, sumW: 0 };
  }

  function computeEstimates(state) {
    const out = {};
    for (const ind of INDICATORS) {
      out[ind.key] = {
        unweighted: estimateOne(state.persons, ind, 'unweighted'),
        weighted: estimateOne(state.persons, ind, 'weighted'),
        trimmed: estimateOne(state.persons, ind, 'trimmed'),
      };
    }
    return out;
  }

  // ---------- 区间估计：层内 bootstrap ----------
  // 每次重抽样：在各可估计层内对回答者有放回抽样（层样本量不变）；
  // 非响应系数沿用全样本值；校准系数、截尾在每次重抽样内重新计算。
  function quantile(sortedArr, p) {
    if (sortedArr.length === 0) return null;
    const pos = p * (sortedArr.length - 1);
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    if (lo === hi) return sortedArr[lo];
    return sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * (pos - lo);
  }

  function bootstrap(state, seed, B) {
    const rand = mulberry32(seed);
    const cfg = state.config;
    // 可估计回答者按层分组
    const byStratum = new Map();
    for (const p of state.persons) {
      if (!p.estimable) continue;
      if (!byStratum.has(p.stratum)) byStratum.set(p.stratum, []);
      byStratum.get(p.stratum).push(p);
    }
    const stratumList = [...byStratum.entries()].map(([key, persons]) => {
      const st = state.strata.find(s => s.key === key);
      return { key, persons, popTotal: st ? st.popTotal : null };
    });

    const draws = {}; // indicatorKey -> weightKind -> [B 个估计值]
    for (const ind of INDICATORS) {
      draws[ind.key] = { unweighted: [], weighted: [], trimmed: [] };
    }

    for (let b = 0; b < B; b++) {
      // 1. 层内有放回重抽样
      const resampled = [];
      const sumWNrByStratum = new Map();
      for (const st of stratumList) {
        const n = st.persons.length;
        let sumWNr = 0;
        for (let i = 0; i < n; i++) {
          const p = st.persons[Math.floor(rand() * n)];
          resampled.push({ person: p, stratum: st.key });
          sumWNr += p.wNr;
        }
        sumWNrByStratum.set(st.key, sumWNr);
      }
      // 2. 重算校准系数
      const calB = new Map();
      for (const st of stratumList) {
        calB.set(st.key, st.popTotal != null && st.popTotal > 0 ? st.popTotal / sumWNrByStratum.get(st.key) : 1);
      }
      // 3. 逐指标、逐列估计
      for (const ind of INDICATORS) {
        const acc = { unweighted: [0, 0], weighted: [0, 0], trimmed: [0, 0] }; // [sumW, sumWY]
        for (const r of resampled) {
          const v = ind.value(r.person.response);
          if (v == null) continue;
          const wNr = r.person.wNr;
          const wCal = wNr * calB.get(r.stratum);
          const wTrim = cfg.trimCap != null ? Math.min(wCal, cfg.trimCap) : wCal;
          acc.unweighted[0] += 1; acc.unweighted[1] += v;
          acc.weighted[0] += wCal; acc.weighted[1] += wCal * v;
          acc.trimmed[0] += wTrim; acc.trimmed[1] += wTrim * v;
        }
        for (const kind of ['unweighted', 'weighted', 'trimmed']) {
          const [sw, swy] = acc[kind];
          if (sw > 0) draws[ind.key][kind].push(swy / sw);
        }
      }
    }

    const ci = {};
    for (const ind of INDICATORS) {
      ci[ind.key] = {};
      for (const kind of ['unweighted', 'weighted', 'trimmed']) {
        const arr = draws[ind.key][kind].sort((x, y) => x - y);
        ci[ind.key][kind] = { lo: quantile(arr, 0.025), hi: quantile(arr, 0.975), reps: arr.length };
      }
    }
    return { seed, B, ci };
  }

  const api = {
    mulberry32, parseCSV, toCSV, INDICATORS,
    dedupeResponses, computePipeline, computeEstimates, bootstrap,
    stratumKey, quantile,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.SurveyWeights = api;
})(typeof window !== 'undefined' ? window : globalThis);
