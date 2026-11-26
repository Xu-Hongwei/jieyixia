from pathlib import Path
import hashlib,json,difflib
root=Path('frontend/src');base=Path('output/frontend-u5-2026-11-26/baseline/src');out=base.parent.parent
changes=[];diff=[]
for p in sorted(root.rglob('*')):
 if not p.is_file():continue
 rel=p.relative_to(root);old=base/rel
 if not old.exists() or p.read_bytes()!=old.read_bytes():
  changes.append({'path':p.as_posix(),'status':'modified' if old.exists() else 'new','sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'baseline':old.as_posix() if old.exists() else None})
  diff.extend(difflib.unified_diff([l+'\n' for l in old.read_text(encoding='utf-8-sig').splitlines()] if old.exists() else [],[l+'\n' for l in p.read_text(encoding='utf-8-sig').splitlines()],fromfile='baseline/'+rel.as_posix(),tofile=p.as_posix()))
(out/'changed-files.json').write_text(json.dumps(changes,ensure_ascii=False,indent=2),encoding='utf8');(out/'u5-changes.diff').write_text(''.join(diff),encoding='utf8')
print('Baseline count:',len(list(base.rglob('*.*'))),'Changed:',len(changes))
for c in changes:print(c['status'],c['path'])
