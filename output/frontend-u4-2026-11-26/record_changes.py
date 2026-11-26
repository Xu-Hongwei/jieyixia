from pathlib import Path
import hashlib,json,difflib
root=Path('frontend/src');base=Path('output/frontend-u4-2026-11-26/baseline/src');out=base.parent.parent
changes=[];diff=[]
for p in sorted(root.rglob('*')):
 if not p.is_file():continue
 rel=p.relative_to(root);old=base/rel
 if not old.exists() or p.read_bytes()!=old.read_bytes():
  changes.append({'path':str(p).replace('\\','/'),'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'baseline':str(old).replace('\\','/')})
  diff+=difflib.unified_diff(old.read_text(encoding='utf-8-sig').splitlines(True) if old.exists() else [],p.read_text(encoding='utf-8-sig').splitlines(True),fromfile='baseline/'+str(rel),tofile='frontend/src/'+str(rel))
(out/'changed-files.json').write_text(json.dumps(changes,ensure_ascii=False,indent=2),encoding='utf8')
(out/'u4-changes.diff').write_text(''.join(diff),encoding='utf8')
print('Baseline files:',sum(1 for p in base.rglob('*') if p.is_file()))
print(json.dumps(changes,ensure_ascii=False,indent=2))
