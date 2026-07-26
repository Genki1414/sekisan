# 足場積算アプリ（AshiBaseSekisan）

戸建・くさび式足場の積算＋割り付け図＋見積書ツール。詳細仕様は [`docs/spec.md`](docs/spec.md) を参照。

## 開発

```bash
npm install
npm run dev
```

## ビルド

```bash
npm run build
```

`main` ブランチへの push で GitHub Actions が自動的に GitHub Pages へデプロイします（`.github/workflows/deploy.yml`）。
