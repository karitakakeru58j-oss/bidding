# 回答記録

- `answers.pbn` … ビッド練習帳の回答（PBN 2.1）。Answer＝あなたの答え、AnswerReason＝理由、AIBid＝その時のAIの答え
- `answers.json` … 同じ内容。`node tools/selftest.js` が「いまのルールとどれだけ一致するか」を数えるのに使う

取り込み方：データベースの `answers` をJSONで保存し、`node tools/import-answers.js <フォルダ>` を実行する。
