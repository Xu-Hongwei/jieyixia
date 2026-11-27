from pathlib import Path
import re,difflib
p=Path('devlog/coordination/2026-11-26-前端U4实施与验收.md')
missing=[]
for target in re.findall(r'\]\(([^)]+)\)',p.read_text(encoding='utf8')):
 if not (p.parent/target).resolve().exists(): missing.append(target)
print('Missing document links:',missing)
base=Path('output/frontend-u4-2026-11-26/baseline/src');root=Path('frontend/src');chunks=[]
for p in sorted(root.rglob('*')):
 if p.is_file() and (base/p.relative_to(root)).read_bytes()!=p.read_bytes():
  old=base/p.relative_to(root)
  chunks.extend(difflib.unified_diff([l+'\n' for l in old.read_text(encoding='utf-8-sig').splitlines()],[l+'\n' for l in p.read_text(encoding='utf-8-sig').splitlines()],fromfile='baseline/'+p.relative_to(root).as_posix(),tofile=p.as_posix()))
Path('output/frontend-u4-2026-11-26/u4-changes.diff').write_text(''.join(chunks),encoding='utf8')
