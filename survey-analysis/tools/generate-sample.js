#!/usr/bin/env node
/**
 * 虚构居民调查示例数据生成器（确定性：固定随机种子，重复运行结果一致）
 *
 * 生成四份 CSV：
 *   sample-data/frame.csv      抽样框（居民登记名单摘录，含分层变量）
 *   sample-data/selected.csv   抽中记录（含入样概率 pi；故意含 2 条缺失）
 *   sample-data/responses.csv  回答结果（故意含重复问卷、无效问卷、项目级缺失）
 *   sample-data/population.csv 人口分层总量（校准目标）
 * 并把四份 CSV 嵌入 js/sample-data.js，供页面离线载入（file:// 无需 fetch）。
 *
 * 数据情节（全部为虚构）：
 *   - 分层不均：滨海区人口最少但超比例抽样（各层入样概率差异大）
 *   - 非响应集中：滨海区 18-34 岁回答率极低；滨海区 60 岁及以上整层无人回答
 *   - 重复问卷：5 个住户重复提交（较早一条为待剔除副本）
 *   - 2 条抽中记录缺入样概率（不可估计）
 *   - 2 条回答不属于抽中名单（无效问卷）
 */
const fs = require('fs');
const path = require('path');

const SEED = 20261115;
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
function randn() { // Box-Muller
  let u = 0, v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// 层定义：人口、抽样框份数、抽样数（非按比例，滨海区超抽样）、回答率、回答倾向
const STRATA = [
  { district: '城东区', age: '18-34岁',    pop: 15000, frameN: 205, n: 36, resp: 0.78, sat: 0.62, com: 0.45 },
  { district: '城东区', age: '35-59岁',    pop: 18000, frameN: 245, n: 44, resp: 0.86, sat: 0.74, com: 0.50 },
  { district: '城东区', age: '60岁及以上', pop: 9000,  frameN: 123, n: 22, resp: 0.82, sat: 0.70, com: 0.42 },
  { district: '城西区', age: '18-34岁',    pop: 10000, frameN: 136, n: 30, resp: 0.62, sat: 0.58, com: 0.40 },
  { district: '城西区', age: '35-59岁',    pop: 13000, frameN: 177, n: 40, resp: 0.48, sat: 0.55, com: 0.38 },
  { district: '城西区', age: '60岁及以上', pop: 8000,  frameN: 109, n: 24, resp: 0.75, sat: 0.68, com: 0.44 },
  { district: '滨海区', age: '18-34岁',    pop: 6000,  frameN: 82,  n: 48, resp: 0.22, sat: 0.35, com: 0.30 },
  { district: '滨海区', age: '35-59岁',    pop: 6000,  frameN: 82,  n: 46, resp: 0.55, sat: 0.50, com: 0.35 },
  { district: '滨海区', age: '60岁及以上', pop: 3000,  frameN: 41,  n: 30, resp: 0.00, sat: 0.60, com: 0.40 }, // 整层无回答
];
const EXERCISE_MEAN = { '18-34岁': 3.5, '35-59岁': 2.8, '60岁及以上': 4.2 };
const INCOME_BASE = { '城东区': 7200, '城西区': 6100, '滨海区': 4800 };
const AGE_RANGE = { '18-34岁': [18, 34], '35-59岁': [35, 59], '60岁及以上': [60, 79] };

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function pad(n, w) { return String(n).padStart(w, '0'); }
function randDate() {
  const start = new Date('2026-09-01T08:00:00').getTime();
  const end = new Date('2026-09-30T22:00:00').getTime();
  const t = new Date(start + rand() * (end - start));
  return `${t.getFullYear()}-${pad(t.getMonth() + 1, 2)}-${pad(t.getDate(), 2)} ${pad(t.getHours(), 2)}:${pad(t.getMinutes(), 2)}:${pad(t.getSeconds(), 2)}`;
}
function shiftDate(ts, days, hours) {
  const t = new Date(ts.replace(' ', 'T'));
  t.setDate(t.getDate() + days);
  t.setHours(t.getHours() + hours);
  return `${t.getFullYear()}-${pad(t.getMonth() + 1, 2)}-${pad(t.getDate(), 2)} ${pad(t.getHours(), 2)}:${pad(t.getMinutes(), 2)}:${pad(t.getSeconds(), 2)}`;
}

// ---------- 1. 抽样框 ----------
const frame = [];
let seq = 0;
for (const s of STRATA) {
  for (let i = 0; i < s.frameN; i++) {
    seq++;
    const [lo, hi] = AGE_RANGE[s.age];
    frame.push({
      person_id: 'HB' + pad(seq, 4),
      district: s.district,
      age_group: s.age,
      sex: rand() < 0.5 ? '男' : '女',
      age: lo + Math.floor(rand() * (hi - lo + 1)),
    });
  }
}

// ---------- 2. 抽中记录 ----------
const selected = [];
const frameByStratum = {};
for (const f of frame) {
  const k = f.district + '|' + f.age_group;
  (frameByStratum[k] = frameByStratum[k] || []).push(f);
}
for (const s of STRATA) {
  const pool = shuffle(frameByStratum[s.district + '|' + s.age].slice());
  const pi = s.n / s.frameN;
  for (let i = 0; i < s.n; i++) {
    selected.push({
      person_id: pool[i].person_id,
      pi: pi.toFixed(6),
      batch: rand() < 0.6 ? '1' : '2',
      _stratum: s, // 内部使用，不导出
    });
  }
}

// ---------- 3. 回答结果 ----------
const responses = [];
const respondedIds = new Set();
for (const sel of selected) {
  const s = sel._stratum;
  if (rand() >= s.resp) continue; // 未回答
  respondedIds.add(sel.person_id);
  const satisfied = rand() < s.sat ? '满意' : '不满意';
  responses.push({
    person_id: sel.person_id,
    submitted_at: randDate(),
    satisfied,
    community: rand() < s.com ? '参与' : '未参与',
    exercise_hours: Math.max(0, EXERCISE_MEAN[s.age] + randn() * 1.2).toFixed(1),
    monthly_income: rand() < 0.06 ? '' : String(Math.round((INCOME_BASE[s.district] * Math.exp(randn() * 0.35)) / 50) * 50),
  });
}

// 重复问卷：挑 5 个已回答者，插入一条更早提交、内容略有出入的副本
const dupPool = responses.filter(r => r.person_id.slice(0, 4) !== 'HB90');
const dupTargets = shuffle(dupPool.slice()).slice(0, 5);
for (const orig of dupTargets) {
  responses.push({
    person_id: orig.person_id,
    submitted_at: shiftDate(orig.submitted_at, -1 - Math.floor(rand() * 2), -Math.floor(rand() * 12)),
    satisfied: orig.satisfied === '满意' ? '不满意' : '满意',
    community: orig.community,
    exercise_hours: orig.exercise_hours,
    monthly_income: orig.monthly_income === '' ? '' : String(Math.round(Number(orig.monthly_income) * (0.9 + rand() * 0.2) / 50) * 50),
  });
}

// 无效问卷：不在抽中名单中的 ID
for (const fake of ['HB9001', 'HB9002']) {
  responses.push({
    person_id: fake,
    submitted_at: randDate(),
    satisfied: '满意', community: '参与', exercise_hours: '5.0', monthly_income: '8000',
  });
}
responses.sort((a, b) => a.submitted_at < b.submitted_at ? -1 : 1);

// 缺失入样概率：挑 2 条已回答的抽中记录（城西区 35-59岁），清空 pi
const missingPiTargets = selected.filter(s => respondedIds.has(s.person_id) && s._stratum.district === '城西区' && s._stratum.age === '35-59岁').slice(0, 2);
for (const t of missingPiTargets) t.pi = '';

// ---------- 4. 人口分层总量 ----------
const population = STRATA.map(s => ({ district: s.district, age_group: s.age, pop_total: s.pop }));

// ---------- 输出 ----------
function toCSV(rows, cols) {
  const esc = v => {
    v = String(v);
    return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  };
  const lines = [cols.map(c => esc(c.label)).join(',')];
  for (const r of rows) lines.push(cols.map(c => esc(r[c.key])).join(','));
  return lines.join('\n') + '\n';
}

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'sample-data');
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(path.join(root, 'js'), { recursive: true });

const csvs = {
  frame: toCSV(frame, [
    { key: 'person_id', label: 'person_id' }, { key: 'district', label: 'district' },
    { key: 'age_group', label: 'age_group' }, { key: 'sex', label: 'sex' }, { key: 'age', label: 'age' },
  ]),
  selected: toCSV(selected, [
    { key: 'person_id', label: 'person_id' }, { key: 'pi', label: 'pi' }, { key: 'batch', label: 'batch' },
  ]),
  responses: toCSV(responses, [
    { key: 'person_id', label: 'person_id' }, { key: 'submitted_at', label: 'submitted_at' },
    { key: 'satisfied', label: 'satisfied' }, { key: 'community', label: 'community' },
    { key: 'exercise_hours', label: 'exercise_hours' }, { key: 'monthly_income', label: 'monthly_income' },
  ]),
  population: toCSV(population, [
    { key: 'district', label: 'district' }, { key: 'age_group', label: 'age_group' }, { key: 'pop_total', label: 'pop_total' },
  ]),
};
for (const [name, csv] of Object.entries(csvs)) {
  fs.writeFileSync(path.join(outDir, name + '.csv'), csv);
}

const js = `// 本文件由 tools/generate-sample.js 生成（种子 ${SEED}），请勿手工修改。
// 内嵌虚构示例数据，使页面在 file:// 协议下也能一键载入（无需 fetch）。
const SAMPLE_DATA = {
  frame: ${JSON.stringify(csvs.frame)},
  selected: ${JSON.stringify(csvs.selected)},
  responses: ${JSON.stringify(csvs.responses)},
  population: ${JSON.stringify(csvs.population)},
};
if (typeof window !== 'undefined') window.SAMPLE_DATA = SAMPLE_DATA;
if (typeof module !== 'undefined') module.exports = SAMPLE_DATA;
`;
fs.writeFileSync(path.join(root, 'js', 'sample-data.js'), js);

// ---------- 统计摘要 ----------
const nResp = respondedIds.size;
console.log('=== 虚构示例数据生成完毕（种子 ' + SEED + '）===');
console.log(`抽样框 ${frame.length} 人；抽中 ${selected.length} 人；有效回答 ${nResp} 人；回答记录 ${responses.length} 行（含重复 ${dupTargets.length}、无效 2）`);
console.log('缺失入样概率：' + missingPiTargets.map(t => t.person_id).join(', '));
console.log('重复问卷 ID：' + dupTargets.map(t => t.person_id).join(', '));
console.log('\n各层：抽中 / 回答 / 回答率 / 基础权重(1/pi)');
for (const s of STRATA) {
  const sel = selected.filter(x => x._stratum === s);
  const resp = sel.filter(x => respondedIds.has(x.person_id)).length;
  console.log(`  ${s.district} ${s.age}：${sel.length} / ${resp} / ${(resp / sel.length * 100).toFixed(0)}% / ${(s.frameN / s.n).toFixed(2)}（人口 ${s.pop}）`);
}
