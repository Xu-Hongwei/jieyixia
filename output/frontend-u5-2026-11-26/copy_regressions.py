from pathlib import Path
out=Path('output/playwright/frontend-u5-2026-11-26');old=Path('output/playwright/frontend-u4-2026-11-26')
for name in ['accept.mjs','workflow.mjs','generation.mjs','u1-regression.mjs','u2-regression.mjs','u3-regression.mjs']:
 (out/name).write_text((old/name).read_text(encoding='utf8'),encoding='utf8')
