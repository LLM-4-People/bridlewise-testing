#!/bin/bash
# EXP435 5000-run wrapper for LongTaskRunner (systemd).
export PATH="/home/example/.nvm/versions/node/v24.18.0/bin:$PATH"
cd /home/example/code-harness-workspaces/landlock-self-protection-v1/experiments/exp435-trim-continuity
export EXP435_LABEL=C09-SUM-5000
export EXP435_TURNS=5000
node scripts/exp435/worker.mjs 2>&1 | tee exp435-C09-SUM-5000-stdout.log
