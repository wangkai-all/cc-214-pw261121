#!/usr/bin/env node
/** 核心计算模块测试：node tests/run-tests.js（无第三方依赖） */
const assert = require('assert');
const path = require('path');
const W = require(path.join(__dirname, '..', 'js', 'weights.js'));
const SAMPLE = require(path.join(__dirname, '..', 'js', 'sample-data.js'));

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; }
}
const approx = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

const data = {
  frame: W.parseCSV(SAMPLE.frame),
  selected: W.parseCSV(SAMPLE.selected),
  responses: W.parseCSV(SAMPLE.responses),
  population: W.parseCSV(SAMPLE.population),
};

console.log('== CSV 解析 ==');
test('四份数据行数正确', () => {
  assert.strictEqual(data.frame.length, 1200);
  assert.strictEqual(data.selected.length, 320);
  assert.strictEqual(data.responses.length, 176);
  assert.strictEqual(data.population.length, 9);
});
test('引号与逗号转义', () => {
  const rows = W.parseCSV('a,b\n"x,""y""",2\n');
  assert.strictEqual(rows[0].a, 'x,"y"');
  assert.strictEqual(rows[0].b, '2');
});
test('BOM 与 \\r\\n 兼容', () => {
  const rows = W.parseCSV('﻿a,b\r\n1,2\r\n');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].b, '2');
});

console.log('== 数据核查 ==');
const state = W.computePipeline(data, { dupRule: 'latest', nrGroup: 'stratum', trimCap: null });
test('剔除 5 条重复问卷，保留最新提交', () => {
  assert.strictEqual(state.issues.duplicatesRemoved.length, 5);
  for (const d of state.issues.duplicatesRemoved) assert.ok(d.kept_at > d.removed_at, '保留的应更新');
});
test('保留最早提交规则生效', () => {
  const s2 = W.computePipeline(data, { dupRule: 'earliest', nrGroup: 'stratum', trimCap: null });
  for (const d of s2.issues.duplicatesRemoved) assert.ok(d.kept_at < d.removed_at, '保留的应更早');
});
test('识别 2 条无效问卷（不在抽中名单）', () => {
  assert.strictEqual(state.issues.responsesNotInSelected.length, 2);
});
test('识别 2 条缺入样概率记录', () => {
  assert.strictEqual(state.issues.missingPi.length, 2);
});
test('识别 1 个整层无回答的层（滨海区 60岁及以上）', () => {
  assert.strictEqual(state.issues.zeroResponseStrata.length, 1);
  assert.strictEqual(state.issues.zeroResponseStrata[0].stratum, '滨海区|60岁及以上');
});

console.log('== 权重计算 ==');
test('基础权重 = 1/pi', () => {
  const p = state.persons.find(p => p.pi != null);
  assert.ok(approx(p.baseWeight, 1 / p.pi));
});
test('非响应系数 = 组内抽中权重和 / 组内回答权重和', () => {
  for (const g of state.nrGroups) {
    if (!g.estimable) continue;
    assert.ok(approx(g.factor, g.sumBaseSel / g.sumBaseResp));
    assert.ok(g.factor >= 1, '调整系数不应小于 1');
  }
});
test('校准后各可估计层权重和 = 人口总量', () => {
  for (const st of state.strata) {
    if (!st.estimable || !st.calibrated) continue;
    const sum = state.persons.filter(p => p.estimable && p.stratum === st.key)
      .reduce((a, p) => a + p.wCal, 0);
    assert.ok(approx(sum, st.popTotal, 1e-6), st.key + ': ' + sum + ' != ' + st.popTotal);
  }
});
test('整层无回答的层不产生任何可估计记录', () => {
  const dead = state.persons.filter(p => p.stratum === '滨海区|60岁及以上');
  assert.ok(dead.length === 30 && dead.every(p => !p.estimable));
});
test('缺 pi 记录即使回答了也不可估计', () => {
  const mp = state.persons.filter(p => p.pi == null);
  assert.strictEqual(mp.length, 2);
  assert.ok(mp.every(p => !p.estimable));
  assert.ok(mp.some(p => p.responded), '其中应有已回答者（演示有回答也不可估计）');
});
test('总体覆盖率 = 可估计层人口 / 全部人口，且 < 100%', () => {
  assert.ok(approx(state.coverage.popAll, 88000));
  assert.ok(approx(state.coverage.popCovered, 85000));
  assert.ok(state.coverage.ratio < 1 && state.coverage.ratio > 0.9);
});
test('校准后总权重和 = 可估计层人口合计', () => {
  assert.ok(approx(state.weightStats.sumCal, 85000, 1e-6));
});

console.log('== 截尾 ==');
const cap = 600;
const trimmed = W.computePipeline(data, { dupRule: 'latest', nrGroup: 'stratum', trimCap: cap });
test('截尾后最大权重不超过上限', () => {
  const mx = Math.max(...trimmed.persons.filter(p => p.estimable).map(p => p.wTrim));
  assert.ok(mx <= cap);
});
test('截尾记录数与权重和变化一致', () => {
  assert.ok(trimmed.weightStats.trimmedCount > 0, '应有记录被截尾');
  assert.ok(trimmed.weightStats.sumTrim < trimmed.weightStats.sumCal, '截尾后权重和应下降');
  assert.ok(approx(
    trimmed.weightStats.sumCal - trimmed.weightStats.sumTrim,
    trimmed.persons.filter(p => p.estimable).reduce((a, p) => a + (p.wCal - p.wTrim), 0)
  ));
});

console.log('== 点估计 ==');
const est = W.computeEstimates(state);
const estT = W.computeEstimates(trimmed);
test('三列估计基于同一可估计集合（n 一致）', () => {
  for (const k of Object.keys(est)) {
    assert.strictEqual(est[k].unweighted.n, est[k].weighted.n);
    assert.strictEqual(est[k].weighted.n, estT[k].trimmed.n);
  }
});
test('满意比例：加权 < 未加权（低满意群体低回答率，加权应下修）', () => {
  assert.ok(est.satisfied.weighted.est < est.satisfied.unweighted.est,
    `weighted=${est.satisfied.weighted.est} unweighted=${est.satisfied.unweighted.est}`);
});
test('比例在 [0,1]，均值合理', () => {
  for (const k of ['satisfied', 'community']) {
    for (const c of ['unweighted', 'weighted']) assert.ok(est[k][c].est >= 0 && est[k][c].est <= 1);
  }
  assert.ok(est.income.weighted.est > 3000 && est.income.weighted.est < 10000);
});
test('项目级缺失：收入指标 n 小于满意指标 n', () => {
  assert.ok(est.income.unweighted.n < est.satisfied.unweighted.n);
});

console.log('== 区间估计（可复现性）==');
const boot1 = W.bootstrap(state, 20261115, 200);
const boot2 = W.bootstrap(state, 20261115, 200);
const boot3 = W.bootstrap(state, 999, 200);
test('同一种子两次运行结果完全一致', () => {
  assert.deepStrictEqual(boot1, boot2);
});
test('不同种子结果不同', () => {
  assert.notDeepStrictEqual(boot1.ci.satisfied.weighted, boot3.ci.weighted);
});
test('区间包含点估计且 lo < hi', () => {
  for (const k of Object.keys(est)) {
    for (const c of ['unweighted', 'weighted']) {
      const ci = boot1.ci[k][c], e = est[k][c].est;
      assert.ok(ci.lo < ci.hi, k + '/' + c);
      assert.ok(ci.lo <= e && e <= ci.hi, `${k}/${c}: ${e} 不在 [${ci.lo}, ${ci.hi}]`);
    }
  }
});
test('截尾列区间同样可复现', () => {
  const b1 = W.bootstrap(trimmed, 42, 100);
  const b2 = W.bootstrap(trimmed, 42, 100);
  assert.deepStrictEqual(b1.ci.income.trimmed, b2.ci.income.trimmed);
});

console.log('== 边界：人口层无抽中记录 ==');
test('人口总量中存在但无抽中记录的层 → 不可估计且计入覆盖率分母', () => {
  const d2 = {
    frame: [{ person_id: 'A1', district: '甲', age_group: '青年' }, { person_id: 'A2', district: '甲', age_group: '青年' }],
    selected: [{ person_id: 'A1', pi: '0.5' }, { person_id: 'A2', pi: '0.5' }],
    responses: [{ person_id: 'A1', submitted_at: '2026-09-01 10:00:00', satisfied: '满意', community: '参与', exercise_hours: '2', monthly_income: '5000' }],
    population: [{ district: '甲', age_group: '青年', pop_total: '100' }, { district: '乙', age_group: '老年', pop_total: '300' }],
  };
  const s = W.computePipeline(d2, { dupRule: 'latest', nrGroup: 'stratum', trimCap: null });
  assert.strictEqual(s.issues.zeroResponseStrata.length, 1);
  assert.strictEqual(s.issues.zeroResponseStrata[0].stratum, '乙|老年');
  assert.strictEqual(s.issues.zeroResponseStrata[0].selected, 0);
  assert.ok(approx(s.coverage.popAll, 400) && approx(s.coverage.popCovered, 100));
  const est2 = W.computeEstimates(s);
  assert.ok(approx(est2.satisfied.weighted.est, 1), '可估计层内估计正常');
});

console.log('\n' + (process.exitCode ? '存在失败用例' : '全部 ' + passed + ' 项通过'));
