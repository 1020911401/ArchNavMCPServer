# 只跑这次改动相关的单测

1. `node scripts/test-select.mjs . --scope unstaged`（staged / compare --base main 同理）
2. 输出里有受影响的测试（按 depth，depth 1 = 直接 import）、改动的测试文件本身、
   以及 `uncovered_symbols`（改了但零覆盖）
3. 门禁形态：`node scripts/test-select.mjs . --scope staged --gate`（有「改动但零覆盖」的符号 → exit 1）
4. 拿到列表就照跑：`node --test <file>...`；不要跑全量 `npm test` 除非改动跨模块

注意：`impact` 的 `suggested_tests` 不能用（它就是"文件名含 test 的所有文件"），以本脚本的图谱边为准。
