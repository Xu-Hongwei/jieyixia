"""Read-only generated-contract and runtime-environment checks."""
import json
import os
import pathlib
import subprocess
import sys
import zipfile

EVIDENCE=pathlib.Path(__file__).resolve().parent
ROOT=EVIDENCE.parents[3]
sys.path.insert(0,str(ROOT))
sys.path.insert(0,str(ROOT/'contract'))
from contract.generate import build_schema, emit_typedefs
schema=build_schema()
print('SCHEMA_MATCH',schema==json.loads((ROOT/'contract/schema.json').read_text(encoding='utf-8')))
print('TYPEDEFS_MATCH',emit_typedefs(schema['$defs'])==(ROOT/'contract/typedefs.d.ts').read_text(encoding='utf-8'))
with zipfile.ZipFile(ROOT/'handoff/截下来-前端交接-2026-11-17.zip') as archive:
    print('ZIP_INTEGRITY',archive.testzip())
    for name in ['contract/models.py','contract/schema.json','contract/typedefs.d.ts','backend/app/validation.py','backend/app/model/registry.py','backend/app/model/adapters.py','backend/README.md']:
        matches=[n for n in archive.namelist() if n.replace('\\','/').endswith(name)]
        print('ZIP_MEMBER',name,'MATCH' if len(matches)==1 and archive.read(matches[0])==(ROOT/name).read_bytes() else 'ABSENT_OR_DIFFERENT')

env={k:v for k,v in os.environ.items() if not k.startswith('JXL_')}
env['JXL_PROVIDER']='fixture'
env['PYTHONIOENCODING']='utf-8'
code="""
import importlib.util, json, pathlib, sys
sys.path.insert(0,str(pathlib.Path.cwd()/'backend'))
from fastapi.testclient import TestClient
from app.main import create_app
body=json.loads(pathlib.Path('fixtures/04-reference-paper.json').read_text(encoding='utf-8'))['source']
payload={'source_id':body['id'],'kind':'text','text':body['text'],'captured_at':body['captured_at']}
print('PYTEST_PRESENT',importlib.util.find_spec('pytest') is not None)
with TestClient(create_app()) as client:
    print('HEALTHZ',client.get('/api/healthz').status_code)
    response=client.post('/api/analyze',json=payload)
    print('ANALYZE',response.status_code)
"""
try:
    p=subprocess.run([str(ROOT/'devlog/private-evidence/cleanenv/Scripts/python.exe'),'-u','-c',code],cwd=ROOT,env=env,capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=15)
    print('RUNTIME_ONLY_EXIT',p.returncode)
    print(p.stdout)
    print(p.stderr[-1000:])
except subprocess.TimeoutExpired:
    print('RUNTIME_ONLY_TIMEOUT')
