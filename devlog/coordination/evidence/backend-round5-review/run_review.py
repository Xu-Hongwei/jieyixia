"""Run offline/local tests with isolated configuration and bounded child processes."""
import os
import pathlib
import subprocess
import sys
import time

EVIDENCE=pathlib.Path(__file__).resolve().parent
ROOT=EVIDENCE.parents[3]
env={k:v for k,v in os.environ.items() if not k.startswith('JXL_')}
env['JXL_PROVIDER']='fixture'
env['PYTHONIOENCODING']='utf-8'
commands=[
    ('pytest-local',[sys.executable,'-u','-m','pytest','-q'],ROOT/'backend',45),
    ('probes-local',[sys.executable,'-u',str(EVIDENCE/'probes.py')],ROOT,15),
]
for name,command,cwd,bound in commands:
    print('START',name,flush=True)
    start=time.monotonic()
    try:
        p=subprocess.run(command,cwd=cwd,env=env,capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=bound)
        content=p.stdout+'\n'+p.stderr
        (EVIDENCE/(name+'.txt')).write_text(content,encoding='utf-8')
        print(name,'exit',p.returncode,'elapsed_s',round(time.monotonic()-start,3),flush=True)
        print(content[-5500:],flush=True)
    except subprocess.TimeoutExpired as exc:
        out=exc.stdout or b''
        err=exc.stderr or b''
        if isinstance(out,bytes):out=out.decode('utf-8','replace')
        if isinstance(err,bytes):err=err.decode('utf-8','replace')
        content='TIMEOUT '+str(bound)+'s\n'+out+'\n'+err
        (EVIDENCE/(name+'.txt')).write_text(content,encoding='utf-8')
        print(name,content[-5000:],flush=True)
