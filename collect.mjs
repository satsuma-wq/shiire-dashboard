#!/usr/bin/env node
/**
 * collect — 仕入れ契約パイプラインの案件ファイル（~/shiire/<caseId>/case.json）を集めて
 * ダッシュボード用の data.enc.json（AES-256-GCM 暗号化）を作り、変化があれば git push する。
 *
 * nemo（常駐機）で 5 分ごとに回す前提。案件ファイルは nemo にしか無いため。
 *
 * 使い方:
 *   PASSPHRASE=<合言葉> node collect.mjs            # data.enc.json を作って push
 *   PASSPHRASE=<合言葉> node collect.mjs --dry      # 中身を表示するだけ（暗号化も push もしない）
 *   PASSPHRASE=<合言葉> node collect.mjs --no-push  # ファイルは作るが push しない
 *
 * 平文の案件データはコミットされない。リポジトリに乗るのは暗号文だけ。
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SHIIRE = process.env.SHIIRE_DIR || join(os.homedir(), 'shiire');
const OUT = join(ROOT, 'data.enc.json');
const PASSPHRASE = process.env.PASSPHRASE;
const ITERATIONS = 310000;
const DRY = process.argv.includes('--dry');
const NO_PUSH = process.argv.includes('--no-push');

if (!PASSPHRASE && !DRY) { console.error('PASSPHRASE を指定してください'); process.exit(1); }

// ── 工程（stage）→ パイプラインの位置と日本語 ─────────────────────────────
// SKILL.md の [0]〜[9] を、人が見て分かる10段階に畳んだもの
const STEPS = [
  '① 起点（契約OKの報告）',
  '② 資料を洗い出し',
  '③ 契約書・重説を作成',
  '④ 承認待ち',
  '⑤ 送付済み・返信待ち',
  '⑥ 先方了承',
  '⑦ 稟議',
  '⑧ 振込準備',
  '⑨ 締結',
  '⑩ 完了',
];
function stageInfo(stage, c) {
  const s = String(stage || '');
  if (/closed|completed/.test(s)) return { step: 10, label: '完了' };
  if (/final_agreed/.test(s)) {
    const r = c.ringi || {};
    // 契約稟議が下りて、手付金の段取り（振込稟議・登録）も済んだ／手で済ませた → 締結待ち
    const furikomiDone = c.tetsuke_furikomi?.requested_at || c.tetsuke_furikomi?.requested_to
      || manualNotes(c).some(n => /^完了/.test(n) && /振込/.test(n));
    if (RINGI_OK.test(String(r.status || '')) && furikomiDone) return { step: 9, label: '締結待ち' };
    if (RINGI_OK.test(String(r.status || ''))) return { step: 8, label: '手付金の振込準備' };
    if (r.tetsuke || c.tetsuke_furikomi) return { step: 8, label: '手付金の振込準備' };
    if (r.doc_url || r.requested_at) return { step: 7, label: '稟議（申請待ち／承認待ち）' };
    return { step: 6, label: '先方了承。稟議へ' };
  }
  if (/_pending$/.test(s)) return { step: 4, label: 'グループの承認待ち' };
  if (/waiting_docs|missing/.test(s)) return { step: 5, label: '資料待ち' };
  if (/monitoring/.test(s)) return { step: 5, label: '返信を監視中' };
  if (/_sent$/.test(s)) return { step: 5, label: '送付済み・返信待ち' };
  if (/collected|reading/.test(s)) return { step: 2, label: '資料を洗い出し中' };
  if (/draft/.test(s)) return { step: 3, label: '契約書・重説を作成中' };
  return { step: 5, label: s || '進行中' };
}

// ── 小道具 ────────────────────────────────────────────────────────────
const WAREKI = { 令和: 2018 };
// 日付欄は「2026-09-24（木）15時を打診（#244）」「契約から3か月取得可（2026-09-19 吉澤さん）」のように
// 括弧の中に“発言日”が入る。括弧より前だけを見ないと、注記の日付を決済日と読んでしまう。
function pickDate(v) {
  if (!v) return null;
  const s = String(v).split(/[（(]/)[0];
  let m = s.match(/(20\d{2})[-/年](\d{1,2})[-/月](\d{1,2})/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  m = s.match(/(令和)\s*(\d{1,2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (m) return `${WAREKI[m[1]] + Number(m[2])}-${String(m[3]).padStart(2, '0')}-${String(m[4]).padStart(2, '0')}`;
  return null;
}
// 「650万円（弊社買付。2026-08-10 初回…）」→「650万円」。一覧で読めるように頭だけ取る
function short(v, n = 60) {
  if (!v) return null;
  let s = String(v).split(/[（(]/)[0].trim();
  if (!s) s = String(v).trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}
function firstStr(...vals) {
  for (const v of vals) { if (typeof v === 'string' && v.trim()) return v.trim(); }
  return null;
}
const today = () => { const d = new Date(Date.now() + 9 * 3600000); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); };
function daysBetween(isoDate) {
  if (!isoDate) return null;
  const [y, m, d] = isoDate.split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - today()) / 86400000);
}
// 案件ファイルの時刻は JST で書かれている。nemo は UTC で動くので明示しないと9時間ずれる。
function daysSince(ts) {
  if (!ts) return null;
  let s = String(ts).trim().replace(' ', 'T');
  if (!/[Zz]|[+-]\d{2}:?\d{2}$/.test(s)) s += '+09:00';
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86400000);
}
// 「今日」の境界も JST で見る

// ── 1案件を読む ──────────────────────────────────────────────────────
function loadCase(base, dir, stageFn = stageInfo) {
  const f = join(base, dir, 'case.json');
  if (!existsSync(f)) return null;
  let c; try { c = JSON.parse(readFileSync(f, 'utf8')); } catch (e) { return { id: dir, name: '（case.json が壊れています）', error: String(e.message).slice(0, 120), status: 'error', step: 0, flags: ['case.json が読めない'] }; }

  const id = firstStr(c.case_id, c.caseId) || dir;
  const name = firstStr(c.name, c.property?.name, c.property?.address, c.property?.所在地) || '';
  const terms = c.terms || {};
  const cp = c.counterparty || {};
  const { step, label } = stageFn(c.stage, c);

  const missing = normalizeMissing(c.missing_docs);
  const missingOpenList = missing.filter(m => m.open);
  const missingOpen = missingOpenList.length;

  const judges = Array.isArray(c.judgements) ? c.judgements : [];
  const judgeOpen = judges.filter(j => {
    const st = String(j.status || '');
    const ans = j.answer;
    return !/answered|closed|済/.test(st) && (ans === null || ans === undefined || ans === '');
  });

  const approvals = Array.isArray(c.approvals) ? c.approvals : [];
  const approvalOpen = approvals.filter(a => {
    const st = String(a.status || '');
    return st === '' ? false : /waiting|pending|未/.test(st);
  });

  const contractDate = pickDate(terms.contract_date ?? terms.契約日);
  const closingDate = pickDate(terms.closing_date ?? terms.payment_date ?? terms.決済日);
  const idle = daysSince(c.last_sent_at);

  const flags = [];
  const dToContract = daysBetween(contractDate);
  if (dToContract !== null && dToContract >= 0 && dToContract <= 7) flags.push(`契約日まで${dToContract}日`);
  if (dToContract !== null && dToContract < 0 && step < 9) flags.push(`契約日を${-dToContract}日過ぎています`);
  if (judgeOpen.length) flags.push(`ジャッジ待ち ${judgeOpen.length}件`);
  if (approvalOpen.length) flags.push(`承認待ち ${approvalOpen.length}件`);
  if (idle !== null && idle >= 3 && step < 9) flags.push(`${idle}日動いていません`);
  if (step >= 6 && !(c.ringi && (c.ringi.doc_url || c.ringi.requested_at))) flags.push('稟議書がまだです');

  return {
    id, name,
    status: c.status || 'active',
    stage: c.stage || '',
    step, step_label: label,
    assignee: firstStr(c.assignee?.name, c.sales_rep) || '—',
    counterparty: [firstStr(cp.company, cp.name), firstStr(cp.person)].filter(Boolean).join('／') || '—',
    role: firstStr(cp.role) || '',
    price: short(firstStr(terms.price, terms.売買価格)),
    deposit: short(firstStr(terms.deposit, terms.手付金)),
    contract_date: contractDate,
    closing_date: closingDate,
    contract_method: short(firstStr(terms.contract_method), 40),
    last_sent_at: c.last_sent_at || null,
    idle_days: idle,
    missing_open: missingOpen,
    missing_total: missing.length,
    missing_done: missing.length - missingOpen,
    judge_open: judgeOpen.map(j => ({ no: j.no || j.id || '', q: String(j.question || j.topic || j.q || '').slice(0, 120) })),
    approval_open: approvalOpen.map(a => ({ no: a.no, kind: String(a.kind || '').slice(0, 60) })),
    ringi: short(firstStr(c.ringi?.status, c.ringi?.form), 50),
    ringi_url: firstStr(c.ringi?.doc_url),
    folder_url: firstStr(c.folder_url),
    updated_at: statSync(f).mtime.toISOString(),
    flags,
    detail: buildDetail(c, { step, judgeOpen, approvalOpen, missingOpenList, idle, missingTotal: missing.length }),
  };
}

// ── 「現在の状況」ページ用 ─────────────────────────────────────────────
// 不足資料は案件によって形がばらばら（文字列／{doc|item, status, note}）なので揃える。
// 「未受領」は「受領」を含むので、先に「未」を見ないと受け取り済みと読んでしまう。
function isOpenStatus(st) {
  const s = String(st || '');
  if (!s) return true;
  if (/未/.test(s)) return true;
  return !/受領|受け取り|完了|不要|無し|なし|格納/.test(s);
}
function normalizeMissing(list) {
  if (!Array.isArray(list)) return [];
  return list.map(m => {
    if (typeof m === 'string') {
      if (/^（メモ）/.test(m)) return null;
      const received = /^(受領|受け取り)/.test(m);
      return { name: clip(m.replace(/^(受領|受け取り)[：:]/, ''), 140), status: received ? '受領' : '', open: !received };
    }
    if (!m || typeof m !== 'object') return null;
    const name = firstStr(m.doc, m.item, m.name) || '（名称なし）';
    return { name: clip(name, 100), status: clip(m.status, 60) || '', note: clip(m.note, 160) || '', open: isOpenStatus(m.status) };
  }).filter(Boolean);
}
function clip(v, n) {
  if (v == null) return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}
// ログは5分ごとの「監視ジョブ…変化なし」で埋まるので、それを除いた“動き”だけ新しい順に拾う
function recentLog(log, n = 6) {
  if (!Array.isArray(log)) return [];
  const out = [];
  for (let i = log.length - 1; i >= 0 && out.length < n; i--) {
    const e = log[i];
    const body = typeof e === 'string' ? e : firstStr(e?.what, e?.text, e?.msg, e?.note, e?.event) || JSON.stringify(e);
    const text = typeof e === 'object' && e && e.who && typeof e.what === 'string' ? `${e.who}：${body}` : body;
    if (/監視ジョブ/.test(text) && /変化なし|新規なし/.test(text)) continue;
    const at = typeof e === 'object' && e ? firstStr(e.at, e.time, e.ts) : null;
    const m = text.match(/^(20\d{2}-\d{2}-\d{2}(?:[ T]\d{1,2}:[\dx]{2})?)\s*/);
    out.push({ at: at || (m ? m[1] : ''), text: clip(m ? text.slice(m[0].length) : text, 320) });
  }
  return out;
}
// ── 細かい工程（あと何が残っているか） ─────────────────────────────────
// 10段階の工程をさらに細かく割って、案件ファイルに残っている記録から「済み／不要／まだ」を決める。
// 担当者が手で済ませた作業は、ringi.todo などに「完了：反社チェック…」「完了（不要）：手付金の振込登録…」と
// 書かれているので、その文言も拾う。拾えないものは case.json の checklist で上書きできる:
//   "checklist": { "furikomi_ringi": "skip", "hansha": { "state": "done", "note": "吉澤さんが手で実施" } }
const RINGI_OK = /承認完了|承認済|決裁済/;
function manualNotes(c) {
  const out = [];
  const push = (v) => { const s = typeof v === 'string' ? v : firstStr(v?.item, v?.text); if (s) out.push(s); };
  for (const arr of [c.ringi?.todo, c.todo, c.tetsuke_furikomi?.todo]) if (Array.isArray(arr)) arr.forEach(push);
  push(c.ringi?.status);
  return out;
}
function buildChecklist(c, { step, missingOpenList, missingTotal }) {
  const stage = String(c.stage || '');
  const closed = c.status === 'closed' || /closed|completed/.test(stage);
  const r = c.ringi || {};
  const tf = c.tetsuke_furikomi || null;
  const cal = c.calendar || {};
  const tk = c.teiketsu || null;
  const notes = manualNotes(c);
  // 「完了：…」「完了（不要）：…」の行から、その作業が手で済んでいるかを拾う
  const manual = (re) => {
    const s = notes.find(n => /^完了/.test(n) && re.test(n));
    return s ? { state: /不要/.test(s.slice(0, 8)) ? 'skip' : 'done', note: clip(s.replace(/^完了(（[^）]*）)?[：:]\s*/, ''), 140) } : null;
  };
  const ringiOk = RINGI_OK.test(String(r.status || ''));
  const ringiApplied = ringiOk || /申請済|申請中|承認待/.test(String(r.status || ''));
  const furikomiManual = manual(/振込/);
  const ov = (c.checklist && typeof c.checklist === 'object') ? c.checklist : {};

  const X = (key, phase, name, who, auto) => {
    let it = { key, phase, name, who, state: auto?.state || 'todo', note: auto?.note || '' };
    const o = ov[key];
    if (typeof o === 'string') it.state = o;
    else if (o && typeof o === 'object') it = { ...it, ...o };
    if (closed && it.state === 'todo') it.state = 'done';
    return it;
  };
  const done = (note = '') => ({ state: 'done', note });
  const todo = (note = '') => ({ state: 'todo', note });

  const list = [
    X('ok', '契約書', '契約OKの報告を受ける', '社内', done()),
    X('collect', '契約書', 'メール・資料を洗い出し、契約条件を固める', '社内', step >= 3 ? done() : todo()),
    X('draft', '契約書', /C/.test(String(c.terms?.rule || '')) ? '契約書・重説のドラフト（物元が作成→弊社でチェック）' : '契約書・重説（案）を作る', '社内',
      step >= 4 || /received|draft\d/.test(stage) ? done() : todo()),
    X('send', '契約書', 'グループ承認を取って先方へ送付', '社内', step >= 5 ? done(c.last_sent_at ? `最終送信 ${String(c.last_sent_at).slice(0, 16)}` : '') : todo()),
    X('agree', '契約書', '先方の了承（条件が確定）', '相手方', step >= 6 ? done() : todo()),
    X('docs', '契約書', '不足書類をすべて受け取る', '相手方',
      missingOpenList.length ? todo(`残り ${missingOpenList.length}件／全${missingTotal}件`) : done(missingTotal ? `全${missingTotal}件 受領` : '')),

    X('hansha', '社内手続き', '反社チェック（売主）', '社内',
      c.hansha?.結果 ? done(`${c.hansha.結果}（受付 ${c.hansha.受付番号 || '—'}・${c.hansha.照会日 || ''}）`) : manual(/反社/) || todo()),
    X('kintone', '社内手続き', 'kintone に物件データを入力', '社内',
      c.kintone?.record_id ? done(`レコード ${c.kintone.record_id}`) : manual(/kintone/i) || todo()),
    X('ringi_doc', '社内手続き', '契約稟議書（備考欄）を作る', '社内', r.doc_url ? done(r.prepared_at ? `${r.prepared_at} 作成` : '') : todo()),
    X('ringi_apply', '社内手続き', `契約稟議を申請${r.applicant ? `（${String(r.applicant).replace(/（.*$/, '')}さん）` : ''}`, '社内',
      ringiApplied ? done() : manual(/稟議の?申請/) || todo(r.status ? clip(r.status, 80) : '')),
    X('ringi_ok', '社内手続き', '契約稟議の承認', '社内',
      ringiOk ? done(clip(String(r.status).match(/承認[^。]*/)?.[0] || '', 80)) : manual(/稟議の承認/) || todo()),

    X('furikomi_sheet', '手付金', '振込管理シートに記入', '社内',
      tf?.furikomi_sheet || tf?.sheet_row ? done(tf.sheet_row ? `${tf.sheet_row}行目` : '') : furikomiManual || todo()),
    X('furikomi_ringi', '手付金', '手付金の振込稟議書を作る', '社内',
      tf?.doc_url ? done(tf.created_at ? `${tf.created_at} 作成` : '') : furikomiManual || todo()),
    X('furikomi_req', '手付金', `振込登録を依頼（${tf?.requested_to ? String(tf.requested_to).replace(/（.*$/, '') : '土田'}さん）`, '社内',
      tf?.requested_at || tf?.requested_to ? done(tf.due ? `期限 ${tf.due}` : '') : furikomiManual || todo()),

    X('cal_contract', '締結', 'カレンダーに契約日を登録（Mgr招待）', '社内',
      cal.contract_event_id ? done(cal.contract_at || '') : todo()),
    X('sign', '締結', '契約の締結（署名・押印）', '社内',
      closed || tk?.status === 'completed' ? done(tk?.completed_at ? `${tk.completed_at} 締結` : '')
        : todo(clip(firstStr(cal.contract_note, cal.contract_at, tk?.status ? `電子契約 ${tk.status}` : null) || '', 140))),
    X('cal_settle', '締結', 'カレンダーに決済日を登録', '社内',
      cal.settlement_event_id ? done(cal.settlement_at || '') : todo(cal.settlement_at || '')),
    X('kintone_done', '締結', 'kintone を「仕入れ契約完了」にする', '社内', closed ? done() : todo()),
  ];
  const next = list.find(i => i.state === 'todo') || null;
  if (next) next.state = 'next';
  return {
    items: list,
    left: list.filter(i => i.state === 'todo' || i.state === 'next').length,
    total: list.length,
    next: next ? { name: next.name, who: next.who, note: next.note } : null,
  };
}

// 「いま何を待っているか」を、ボールを持っている人ごとに並べる。先頭が一番の詰まりどころ
function buildDetail(c, { step, judgeOpen, approvalOpen, missingOpenList, idle, missingTotal }) {
  const waits = [];
  for (const a of approvalOpen) waits.push({ who: '社内', what: `グループの承認待ち（#${a.no}）：${clip(a.kind, 80)}` });
  for (const j of judgeOpen) waits.push({ who: '社内', what: `判断待ち（${String(j.no).startsWith('J') ? j.no : 'J' + j.no}）：${clip(j.question || j.topic || j.q, 120)}` });
  const todo = Array.isArray(c.todo) ? c.todo : [];
  for (const t of todo) { const x = typeof t === 'string' ? t : firstStr(t?.item, t?.text); if (x && !/済$|完了$/.test(x)) waits.push({ who: '社内', what: clip(x, 160) }); }
  const r = c.ringi || null;
  const ringiStatus = r ? firstStr(r.status) : null;
  if (r && ringiStatus && !/承認済|完了|決裁済/.test(ringiStatus)) waits.push({ who: '社内', what: `稟議：${clip(ringiStatus, 120)}` });
  const stage = String(c.stage || '');
  const sentish = /_sent$|monitoring|waiting/.test(stage);
  if (missingOpenList.length) waits.push({ who: '相手方', what: `未受領の書類 ${missingOpenList.length}件（下に一覧）` });
  if (sentish && !approvalOpen.length && !judgeOpen.length) waits.push({ who: '相手方', what: `こちらから送付済み。返信待ち${idle != null ? `（最終送信から${idle === 0 ? '今日' : idle + '日'}）` : ''}` });

  const checklist = buildChecklist(c, { step, missingOpenList, missingTotal });
  let headline;
  if (waits.length) headline = waits[0];
  else if (step >= 10) headline = { who: '—', what: '完了しています' };
  else if (checklist.next) headline = { who: checklist.next.who, what: `次は「${checklist.next.name}」${checklist.next.note ? `：${checklist.next.note}` : ''}` };
  else headline = { who: '—', what: '止まっている要因は見つかりません（次の工程へ進行中）' };

  return {
    headline, waits, checklist,
    stage_raw: stage,
    stage_note: clip(firstStr(c._stage_note, c.stage_note, c.irregular && typeof c.irregular === 'string' ? c.irregular : null), 500),
    missing: missingOpenList,
    judges: judgeOpen.map(j => ({ no: j.no || '', q: clip(j.question || j.topic || j.q, 300), detail: clip(j.detail, 400) })),
    approvals: approvalOpen.map(a => ({ no: a.no, kind: clip(a.kind, 120), note: clip(a.note || a.what, 200), at: a.registered_at || a.at || '' })),
    ringi: r ? { status: clip(ringiStatus, 200), form: clip(r.form, 120), flow: clip(r.flow, 120), applicant: clip(r.applicant, 60) } : null,
    log: recentLog(c.log),
  };
}

// ── 集める ────────────────────────────────────────────────────────────
function collectDir(base, stageFn) {
  const dirs = existsSync(base)
    // TEST- で始まるフォルダは電子契約などの開通テスト用。記録として残すが画面には出さない
    ? readdirSync(base).filter(d => { if (/^TEST-/i.test(d)) return false; try { return statSync(join(base, d)).isDirectory(); } catch { return false; } })
    : [];
  const list = dirs.map(d => loadCase(base, d, stageFn)).filter(Boolean);
  // 表示順：締結が近い順 → 詰まっている順 → 案件番号
  const rank = (c) => {
    const d = daysBetween(c.contract_date);
    return [d === null ? 9999 : (d < 0 ? 0 : d), -(c.flags?.length || 0)];
  };
  list.sort((a, b) => { const ra = rank(a), rb = rank(b); return ra[0] - rb[0] || ra[1] - rb[1] || String(a.id).localeCompare(String(b.id)); });
  return list;
}
function summarize(list) {
  const active = list.filter(c => c.status !== 'closed');
  return {
    active: active.length,
    closed: list.length - active.length,
    judge_open: active.reduce((n, c) => n + c.judge_open.length, 0),
    approval_open: active.reduce((n, c) => n + c.approval_open.length, 0),
    missing_open: active.reduce((n, c) => n + c.missing_open, 0),
    stalled: active.filter(c => c.idle_days !== null && c.idle_days >= 3 && c.step < 9).length,
    contract_7days: active.filter(c => { const d = daysBetween(c.contract_date); return d !== null && d >= 0 && d <= 7; }).length,
  };
}

// 販売契約パイプライン（BC間・弊社＝売主）。設計書 hanbai-keiyaku/DESIGN.md の [0]〜[12]。
// まだ実装前なので ~/hanbai は空。案件ファイルができたら、そのまま画面に載る。
const HANBAI = process.env.HANBAI_DIR || join(os.homedir(), 'hanbai');
const HANBAI_STEPS = [
  '① 買付受領', '② 買主の確認', '③ 条件を固める', '④ 売渡承諾', '⑤ 契約書3点セット作成',
  '⑥ 承認→買主へ送付', '⑦ 売却契約稟議', '⑧ 契約締結', '⑨ 手付金の入金確認', '⑩ 融資の本承認待ち',
  '⑪ 決済準備', '⑫ 決済・引渡し', '⑬ 後処理（掲載停止など）',
];
function hanbaiStage(stage, c) {
  const n = Number(c.step);
  if (Number.isFinite(n) && n >= 0 && n <= 12) return { step: n + 1, label: HANBAI_STEPS[n].replace(/^\S+\s/, '') };
  if (/closed|completed/.test(String(stage || ''))) return { step: 13, label: '完了' };
  return { step: 1, label: String(stage || '進行中') };
}

const cases = collectDir(SHIIRE, stageInfo);
const hanbaiCases = collectDir(HANBAI, hanbaiStage);
const active = cases.filter(c => c.status !== 'closed');
const payload = {
  generated_at: new Date().toISOString(),
  source: `${os.hostname()}:${SHIIRE}`,
  summary: summarize(cases),
  steps: STEPS,
  cases,
  hanbai: {
    ready: false,                    // パイプライン本体ができたら true にする
    source: `${os.hostname()}:${HANBAI}`,
    summary: summarize(hanbaiCases),
    steps: HANBAI_STEPS,
    cases: hanbaiCases,
  },
};

if (DRY) { console.log(JSON.stringify(payload, null, 2)); process.exit(0); }

// ── 暗号化 ────────────────────────────────────────────────────────────
const { subtle } = webcrypto;
const b64 = (b) => Buffer.from(b).toString('base64');
// salt は据え置き（合言葉から作る鍵をブラウザ側でキャッシュできるようにするため）。
// salt は秘密ではなく、総当たりを遅くするのは PBKDF2 の反復回数のほう。
let salt;
if (existsSync(OUT)) { try { salt = Buffer.from(JSON.parse(readFileSync(OUT, 'utf8')).salt, 'base64'); } catch { /* noop */ } }
if (!salt || salt.length !== 16) salt = Buffer.from(webcrypto.getRandomValues(new Uint8Array(16)));
const iv = webcrypto.getRandomValues(new Uint8Array(12));
const material = await subtle.importKey('raw', new TextEncoder().encode(PASSPHRASE), 'PBKDF2', false, ['deriveKey']);
const key = await subtle.deriveKey({ name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(payload)));

// 中身が前回と同じなら書かない（無駄なコミットを避ける）
const body = { salt: b64(salt), iv: b64(iv), iterations: ITERATIONS, ct: b64(ct) };
const fingerprintFile = join(ROOT, '.last-fingerprint');
const fingerprint = JSON.stringify({ ...payload, generated_at: null });
const prev = existsSync(fingerprintFile) ? readFileSync(fingerprintFile, 'utf8') : '';
const changed = prev !== fingerprint;

writeFileSync(OUT, JSON.stringify(body));
writeFileSync(fingerprintFile, fingerprint);
console.log(JSON.stringify({ ok: true, cases: cases.length, active: active.length, changed, out: OUT }));

if (NO_PUSH || !changed) process.exit(0);

// ── push ──────────────────────────────────────────────────────────────
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();
try {
  // Mac 側で画面を直して push していることがあるので、先に取り込んでから送る。
  // data.enc.json を書いた後なので作業ツリーは汚れている → --autostash で退避させる
  try {
    git('fetch', 'origin', 'main');
    git('rebase', '--autostash', 'origin/main');
  } catch (e) {
    try { git('rebase', '--abort'); } catch (e2) { /* rebase が始まっていなければ何もしない */ }
  }
  git('add', 'data.enc.json');
  const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: ROOT, encoding: 'utf8' }).trim();
  if (!staged) process.exit(0);
  git('-c', 'user.name=tacumi-bot', '-c', 'user.email=portal@reatex.co.jp', 'commit', '-m', `data: ${new Date().toISOString()}（案件 ${active.length}件）`);
  git('push', 'origin', 'HEAD:main');
  console.log(JSON.stringify({ ok: true, pushed: true }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, pushed: false, error: String(e.message).slice(0, 300) }));
  process.exit(1);
}
