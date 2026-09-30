#!/usr/bin/env bash
# Vercel「Ignored Build Step」：exit 0 = 跳過這次建置，exit 1 = 照常建置。
#
# 為什麼：2026-09-30 三個 Vercel 專案（兩個前端、一個 signal-api）的 Hobby 部署額度
# 用完，PR #202 合併後正式站無法部署。
#
# 注意：被這個腳本取消的部署**仍計入每日部署額度**（Vercel 文件 Ignored Build Step 一節）。
# 真正省額度的是 vercel.json 的 `git.deploymentEnabled`（只有 master 與 preview/** 建立
# 部署，其他分支根本不建）。這個腳本只省建置時間與併發槽，並避免 master 上只改了別的
# 專案時重建本專案。
#
# 比對基準是「這個專案在這個分支上一次成功部署的 commit」（VERCEL_GIT_PREVIOUS_SHA），
# 不是 HEAD^：若上一次部署被額度擋下，下一次 push 即使沒動到本專案，也必須把
# 積欠的變更部署上去；只比 HEAD^ 會讓那些變更永遠上不了線。
#
# 任何不確定（沒有基準 SHA、shallow clone 裡找不到它、git 出錯）一律照常建置。
#
# 用法（在 vercel.json 的 ignoreCommand，工作目錄是專案的 Root Directory）：
#   bash ../scripts/vercel-ignore-build.sh .                 # frontend
#   bash ../../scripts/vercel-ignore-build.sh . ../package.json ../package-lock.json   # agent/signal-api
set -u

ref="${VERCEL_GIT_COMMIT_REF:-}"
prev="${VERCEL_GIT_PREVIOUS_SHA:-}"

# dependabot 的 preview 建置沒有人看，GitHub Actions 已經驗證過 build。
case "$ref" in
  dependabot/*)
    echo "skip: dependabot 分支（$ref）不建 preview"
    exit 0
    ;;
esac

if [ "$#" -eq 0 ]; then
  echo "build: 未指定要比對的路徑"
  exit 1
fi

if [ -z "$prev" ]; then
  echo "build: 沒有上一次成功部署的 SHA"
  exit 1
fi

if ! git cat-file -e "${prev}^{commit}" 2>/dev/null; then
  # Vercel 預設 shallow clone；試著補抓基準 commit，抓不到就照常建置。
  # 不詢問憑證、20 秒逾時：ignore step 卡住比多建置一次更糟。
  GIT_TERMINAL_PROMPT=0 timeout 20 git fetch --quiet --depth=200 origin "$prev" 2>/dev/null || true
  if ! git cat-file -e "${prev}^{commit}" 2>/dev/null; then
    echo "build: clone 裡找不到上一次部署的 commit ${prev}"
    exit 1
  fi
fi

git diff --quiet "$prev" HEAD -- "$@"
rc=$?
case "$rc" in
  0)
    echo "skip: 自 ${prev:0:7} 以來 $* 沒有變更"
    exit 0
    ;;
  1)
    echo "build: 自 ${prev:0:7} 以來 $* 有變更"
    ;;
  *)
    echo "build: git diff 失敗（exit $rc）"
    ;;
esac
exit 1
