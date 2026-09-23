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
function loadCase(dir) {
  const f = join(SHIIRE, dir, 'case.json');
  if (!existsSync(f)) return null;
  let c; try { c = JSON.parse(readFileSync(f, 'utf8')); } catch (e) { return { id: dir, name: '（case.json が壊れています）', error: String(e.message).slice(0, 120), status: 'error', step: 0, flags: ['case.json が読めない'] }; }

  const id = firstStr(c.case_id, c.caseId) || dir;
  const name = firstStr(c.name, c.property?.name, c.property?.address, c.property?.所在地) || '';
  const terms = c.terms || {};
  const cp = c.counterparty || {};
  const { step, label } = stageInfo(c.stage, c);

  const missing = Array.isArray(c.missing_docs) ? c.missing_docs : [];
  const missingOpen = missing.filter(m => !/受領|受け取り|完了|不要/.test(String(m.status || ''))).length;

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
    judge_open: judgeOpen.map(j => ({ no: j.no || j.id || '', q: String(j.question || j.q || '').slice(0, 120) })),
    approval_open: approvalOpen.map(a => ({ no: a.no, kind: String(a.kind || '').slice(0, 60) })),
    ringi: short(firstStr(c.ringi?.status, c.ringi?.form), 50),
    ringi_url: firstStr(c.ringi?.doc_url),
    folder_url: firstStr(c.folder_url),
    updated_at: statSync(f).mtime.toISOString(),
    flags,
  };
}

// ── 集める ────────────────────────────────────────────────────────────
const dirs = existsSync(SHIIRE)
  ? readdirSync(SHIIRE).filter(d => { try { return statSync(join(SHIIRE, d)).isDirectory(); } catch { return false; } })
  : [];
const cases = dirs.map(loadCase).filter(Boolean);

// 表示順：締結が近い順 → 詰まっている順 → 案件番号
const rank = (c) => {
  const d = daysBetween(c.contract_date);
  return [d === null ? 9999 : (d < 0 ? 0 : d), -(c.flags?.length || 0)];
};
cases.sort((a, b) => { const ra = rank(a), rb = rank(b); return ra[0] - rb[0] || ra[1] - rb[1] || String(a.id).localeCompare(String(b.id)); });

const active = cases.filter(c => c.status !== 'closed');
const payload = {
  generated_at: new Date().toISOString(),
  source: `${os.hostname()}:${SHIIRE}`,
  summary: {
    active: active.length,
    closed: cases.length - active.length,
    judge_open: active.reduce((n, c) => n + c.judge_open.length, 0),
    approval_open: active.reduce((n, c) => n + c.approval_open.length, 0),
    missing_open: active.reduce((n, c) => n + c.missing_open, 0),
    stalled: active.filter(c => c.idle_days !== null && c.idle_days >= 3 && c.step < 9).length,
    contract_7days: active.filter(c => { const d = daysBetween(c.contract_date); return d !== null && d >= 0 && d <= 7; }).length,
  },
  steps: STEPS,
  cases,
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
