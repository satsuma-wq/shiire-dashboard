#!/usr/bin/env node
// 社内認証（合言葉）付きページのビルドスクリプト
//
// src/*.html（平文）を AES-256-GCM で暗号化し、
// 合言葉の入力画面を持つ dist 用 HTML をリポジトリ直下に生成する。
// 平文は一切コミットされないため、リポジトリを見ても中身は読めない。
//
// 使い方:  PASSPHRASE=合言葉 node build.mjs

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = join(ROOT, 'src');
const PASSPHRASE = process.env.PASSPHRASE;
const ITERATIONS = 310000;

if (!PASSPHRASE) {
  console.error('PASSPHRASE 環境変数を指定してください');
  process.exit(1);
}

const { subtle } = webcrypto;
const getRandomValues = (arr) => webcrypto.getRandomValues(arr);
const b64 = (buf) => Buffer.from(buf).toString('base64');

async function deriveKey(passphrase, salt) {
  const material = await subtle.importKey(
    'raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']
  );
  return subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false, ['encrypt', 'decrypt']
  );
}

async function encrypt(plaintext) {
  const salt = getRandomValues(new Uint8Array(16));
  const iv = getRandomValues(new Uint8Array(12));
  const key = await deriveKey(PASSPHRASE, salt);
  const ct = await subtle.encrypt(
    { name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext)
  );
  return { salt: b64(salt), iv: b64(iv), ct: b64(ct) };
}

const gate = readFileSync(join(ROOT, 'gate.template.html'), 'utf8');

for (const name of readdirSync(SRC).filter((f) => f.endsWith('.html'))) {
  const plaintext = readFileSync(join(SRC, name), 'utf8');
  const payload = await encrypt(plaintext);
  const out = gate
    .replace('__ITERATIONS__', String(ITERATIONS))
    .replace('__SALT__', payload.salt)
    .replace('__IV__', payload.iv)
    .replace('__CIPHERTEXT__', payload.ct);
  writeFileSync(join(ROOT, name), out);
  console.log(`暗号化: src/${name} -> ${name}  (${payload.ct.length} bytes)`);
}
