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
| `page-src/*.html` | 単発ページの本体（平文・gitignore） |
| `build-page.mjs` | `page-src/<name>.html` を**個別の合言葉**で暗号化して `<name>.html` を作る |
| `koukai-kadai.html` | 掲載・公開まわりの確認事項一覧（2026-10-04・合言葉 `rtx2026`） |

`koukai-kadai.html` の回答欄は Google スプレッドシートです（ページに iframe で埋め込み、各行の「回答」ボタンから該当セルへ飛ぶ）。

- 回答シート: `1m19YBhI8uzkTb6eHdyWzEVhRK3t6O89q1UJbg2FYFmE`（オーナー satsuma@／五十嵐・鶴野・小松に編集権限）
- 列: A 項目(K番号)・B 担当・C 案件番号・D 物件住所・E 確認したいこと・F ご回答・G 回答者・H 回答日
- 回答が入ったら反映して、その行をページから消す（`page-src/koukai-kadai.html` を直して `build-page.mjs` で作り直す）
- 行を増やすとボタンのリンク先（`#gid=0&range=F<行番号>`）がずれるので、行の追加は末尾に足す

単発ページは合言葉がダッシュボードと別なので、`build.mjs`（`src/*.html` だけを見る）では作り直されません。

```bash
PASSPHRASE=rtx2026 node build-page.mjs koukai-kadai.html
```

## 作り直すとき

```bash
PASSPHRASE=<合言葉> node build.mjs     # 画面を直したとき
git add -A && git commit -m "update" && git push
```

データ側は nemo の `shiire-dashboard.timer` が自動で回します。手で回すなら nemo で：

```bash
cd ~/shiire-dashboard && PASSPHRASE=<合言葉> node collect.mjs
```
