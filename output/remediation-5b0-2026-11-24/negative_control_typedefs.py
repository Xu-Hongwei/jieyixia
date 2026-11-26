"""R2 负向对照：用真实生成器代码模拟修复前行为（剥离 oneOf 分支），
证明 narrowing.test-d.ts 能机械检出「联合丢成 unknown」的回归。
只在 output/remediation-5b0-2026-11-24/ 内写临时文件；不改提案生成物。
"""
import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PROPOSAL = ROOT / "contract/proposals/assistant-v1"
sys.path.insert(0, str(PROPOSAL))
import generate as G

HERE = Path(__file__).resolve().parent
SCRATCH = HERE / "pre-fix-typedefs"
(SCRATCH / "typecheck").mkdir(parents=True, exist_ok=True)

original_ts_type = G.ts_type


def pre_fix_ts_type(node):
    if isinstance(node, dict) and "oneOf" in node:
        node = {k: v for k, v in node.items() if k != "oneOf"}
    return original_ts_type(node)


G.ts_type = pre_fix_ts_type
schema = G.build_schema()
(SCRATCH / "typedefs.d.ts").write_text(G.emit_typedefs(schema["$defs"]), encoding="utf-8")
G.ts_type = original_ts_type

shutil.copy(PROPOSAL / "typecheck/narrowing.test-d.ts", SCRATCH / "typecheck/narrowing.test-d.ts")
(SCRATCH / "typecheck/tsconfig.json").write_text(json.dumps({
    "compilerOptions": {"strict": True, "noEmit": True, "target": "ES2022",
                        "module": "ESNext", "moduleResolution": "bundler", "types": [], "skipLibCheck": False},
    "include": ["narrowing.test-d.ts", "../typedefs.d.ts"],
}, indent=2), encoding="utf-8")

bad = (SCRATCH / "typedefs.d.ts").read_text(encoding="utf-8")
assert "task_proposals?: Array<unknown>" in bad, "模拟失败：未复现 unknown 退化"

proc = subprocess.run(
    ["node", str(ROOT / "frontend/node_modules/typescript/bin/tsc"), "-p", str(SCRATCH / "typecheck/tsconfig.json")],
    capture_output=True, text=True, encoding="utf-8", cwd=str(ROOT),
)
(HERE / "negative-control-tsc.txt").write_text(proc.stdout + proc.stderr, encoding="utf-8")
print(proc.stdout[:2000])
print(f"pre-fix tsc exit={proc.returncode}（预期非 0：收窄用例应失败）")
if proc.returncode == 0:
    print("[FAIL] 负向对照未检出回归")
    sys.exit(1)
print("[OK] 负向对照成立：同一份收窄用例在修复前生成物上编译失败")