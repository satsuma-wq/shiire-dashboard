# 仕入れ契約パイプライン ダッシュボード

社内限定。合言葉を入れると開きます。

- 公開URL: https://satsuma-wq.github.io/shiire-dashboard/
- 中身は AES-256-GCM で暗号化してコミットしています。リポジトリを見ても案件データは読めません。
- 平文（`src/`・案件データ）はコミットしていません。

## 仕組み

| ファイル | 役割 |
|---|---|
| `src/index.html` | ダッシュボード本体（平文・gitignore） |
| `build.mjs` | `src/index.html` を暗号化して `index.html` を作る |
| `gate.template.html` | 合言葉の入力画面 |
| `collect.mjs` | nemo で5分ごとに走り、`~/shiire/*/case.json` を集めて `data.enc.json` を作って push |
| `data.enc.json` | 暗号化した案件データ。画面は60秒ごとにこれを読み直す |

## 作り直すとき

```bash
PASSPHRASE=<合言葉> node build.mjs     # 画面を直したとき
git add -A && git commit -m "update" && git push
```

データ側は nemo の `shiire-dashboard.timer` が自動で回します。手で回すなら nemo で：

```bash
cd ~/shiire-dashboard && PASSPHRASE=<合言葉> node collect.mjs
```
