#!/usr/bin/env node
// 単発ページ用のビルドスクリプト（build.mjs とは別。合言葉を個別に決めたいページに使う）
//
// page-src/<name>.html（平文・gitignore）を AES-256-GCM で暗号化し、
// gate.template.html の合言葉入力画面に埋め込んで <name>.html をリポジトリ直下に作る。
// build.mjs は src/*.html だけを見るので、このページを後から別の合言葉で上書きしない。
//
// 使い方:  PASSPHRASE=合言葉 node build-page.mjs koukai-kadai.html

import { readFileSync, writeFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PASSPHRASE = process.env.PASSPHRASE;
const ITERATIONS = 310000;
const name = process.argv[2];

if (!PASSPHRASE || !name) {
  console.error('使い方: PASSPHRASE=合言葉 node build-page.mjs <page-src の HTML ファイル名>');
  process.exit(1);
}

const { subtle } = webcrypto;
const b64 = (buf) => Buffer.from(buf).toString('base64');

const salt = webcrypto.getRandomValues(new Uint8Array(16));
const iv = webcrypto.getRandomValues(new Uint8Array(12));
const material = await subtle.importKey('raw', new TextEncoder().encode(PASSPHRASE), 'PBKDF2', false, ['deriveKey']);
const key = await subtle.deriveKey(
  { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
  material, { name: 'AES-GCM', length: 256 }, false, ['encrypt']
);
const plaintext = readFileSync(join(ROOT, 'page-src', name), 'utf8');
const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));

const out = readFileSync(join(ROOT, 'gate.template.html'), 'utf8')
  .replace('__ITERATIONS__', String(ITERATIONS))
  .replace('__SALT__', b64(salt))
  .replace('__IV__', b64(iv))
  .replace('__CIPHERTEXT__', b64(ct));

writeFileSync(join(ROOT, name), out);
console.log(`暗号化: page-src/${name} -> ${name}  (${b64(ct).length} bytes)`);
