# bass-tabs

MusicXML を読み込んで、**A4 にきれいに印刷できる楽譜**を表示するビューア。
ベース練習用の譜面を紙で用意することが目的。

Vite + React + TypeScript / 描画は [OpenSheetMusicDisplay](https://opensheetmusicdisplay.org/) (OSMD)。

## これは何ではないか

画面で弾きながら追う用途（再生・カーソル追従・テンポ変更・区間ループ）は**対象外**。
このサイトは印刷物を出すためのもので、そちらの用途は alphaTab で別途検討する。

## 使い方

```sh
npm install
npm run dev        # 開発サーバ
```

「ファイルを開く」で `.xml` / `.musicxml` / `.mxl` を選ぶ → A4 縦に組まれた楽譜が出る → 「印刷」。
サーバもアップロードも無く、ファイルはブラウザ内でのみ処理される。

`public/samples/` に動作確認用の譜面が入っている（通常譜・TAB 譜・圧縮 `.mxl`）。

## スクリプト

| コマンド | 内容 |
| --- | --- |
| `npm run dev` | 開発サーバ |
| `npm run build` | `typecheck` してから本番ビルド |
| `npm run preview` | ビルド結果の確認 |
| `npm run lint` | oxlint |
| `npm run typecheck` | `tsc -b --noEmit` |
| `npm run check` | lint + typecheck（CI と同じ） |

### なぜ oxlint と tsc の両方なのか

oxlint は速度を理由に選んでいるが、型情報を使う検査（typescript-eslint の型付きルール相当）を
完全にはカバーしない。その層は `tsc` で埋める。**片方だけでは足りない**という実例が実際に出た:
`backend: BackendType.SVG` は oxlint を素通りしたが `tsc` が拒否した（OSMD 2.1.2 の `backend` は
`string` 型で、数値 enum の `BackendType` は代入できない。正しくは `backend: 'svg'`）。

## 印刷設計

- **SVG バックエンド固定。** Canvas はラスタなので画面では同じに見えても印刷で音符の縁がぼやける。
  SVG ならプリンタ解像度でそのまま出る。
- **ページ分割は OSMD にやらせる。** `pageFormat: 'A4_P'` を指定すると OSMD がページ単位に組み、
  1 ページ = 1 個の `<svg>` として出力する。CSS の改ページ任せにすると段の途中で切れる。
- **紙のサイズは CSS が一度だけ宣言する。** レンダリング後に各ページ `<svg>` の `width`/`height`
  属性を `viewBox` に置き換えているので、画面では可変幅・印刷では `210mm × 297mm` と、
  再レンダリング無しでサイズを変えられる（`src/score/useOsmd.ts` の `makePagesScalable`）。

## 実機で確認した結果 (2026-08-20, OSMD 2.1.2 / Chromium 1194)

Chromium で実際に読み込み・印刷（PDF 出力）まで通して確認した。

### OSMD のオプション名（バージョンで変わりうるので実測値）

| 指定 | 値 | 備考 |
| --- | --- | --- |
| `pageFormat` | `'A4_P'` | **アンダースコア区切り**。`OpenSheetMusicDisplay.PageFormatStandards` に `A4_P` = 210×297mm として定義。`'A4 P'` ではない |
| `backend` | `'svg'` | 型は `string`。`'svg'`/`'SVG'`/未指定以外は Canvas になる |
| `drawingParameters` | `'default'` | |
| `disableCursor` | `true` | 再生しないのでカーソル要素は不要 |
| `autoResize` | `false` | true だとウィンドウリサイズのたびに再レンダリングして固定幅と競合する |

`osmd.load()` は `Blob` を直接受け取り、`.mxl` の解凍も内部で行う（JSZip 同梱）。
そのため `.xml` と `.mxl` で読み込み経路を分ける必要は無かった。

### A4 指定とブラウザの印刷縮尺

噛み合う。`@page { size: A4 portrait; margin: 0 }` + ページ `<svg>` を `210mm × 297mm` で、
Chromium の PDF 出力は **209.9 × 297.0 mm**（= A4）になった。

`@page` の余白を 0 にしているのは、**OSMD が自前のページ余白を持っているため**。実測で
左右約 13mm・上 12〜13mm・下 17mm 以上あり、一般的なプリンタの印字可能領域に収まる。
したがって印刷ダイアログの倍率は「実際のサイズ / 100%」を選べばよく、
「用紙に合わせる」で数 % 縮んでも内容が切れることはない。

### TAB 譜（タブラチュア）

**実用になる。** 「五線譜のみ対応」と割り切る必要は無かった。
TAB クレフ、4 線譜、フレット番号、`staff-tuning` によるチューニング反映、
通常譜との 2 段組み（`<staves>2</staves>` + `<clef number="2"><sign>TAB</sign>`）が
いずれも正しく描画される。OSMD 2.1.2 は `TabKeySignatureRendered` / `TabBeamsRendered` /
`TabTupletsBracketed` など TAB 専用の調整ルールも持っている。
確認は `public/samples/bass-tab.musicxml`（4 弦ベース E1-A1-D2-G2）で行った。

### 複数ページ時の調号・拍子の再掲

- **調号と音部記号は再掲される。** 2 ページ目冒頭（54 小節目）にヘ音記号とシャープ 3 つが出る。
  DOM 上でも 1 ページ目 8 システム / 調号 8・音部記号 8、2 ページ目 9 システム / 調号 9・音部記号 9 と、
  全システムに付いている。
- **拍子記号は再掲されない。** 曲頭に 1 個だけ。これは通常の浄書慣習どおり（拍子は変化時のみ再掲）
  なので、そのままにしてある。

### 実装上つまずいた点（DOM 構造に依存する箇所）

OSMD は各ページ `<svg>` を**それぞれ専用のラッパー `<div>` に入れる**。ここから 2 つ問題が出た。
どちらも修正済みだが、OSMD 更新時に再発しうるので記録しておく。

1. ラッパーが shrink-to-fit すると（例: 親を `align-items: center` にする）、`viewBox` 化した
   `<svg>` には固有サイズが無いため置換要素の既定値 300px に潰れ、`width: min(100%, 210mm)` の
   `100%` がその 300px を基準に解決されてしまう。→ ラッパーを常に全幅にしている。
2. 各 `<svg>` が別々の親を持つので、CSS の `:last-of-type` が**全ページにマッチ**する。
   「最後のページだけ改行しない」を CSS で書くと全ページの `break-after` が消え、
   PDF のページ数が壊れる。→ 改ページは JS 側でインデックスを見てクラス付与している。

## ライセンス

MIT
