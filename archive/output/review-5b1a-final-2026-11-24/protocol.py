import sys, json
from pathlib import Path
root=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(root/'contract/proposals/assistant-v1'))
from models import UserConfirmation
data=dict(confirmation_id='c',draft_revision=1,object_type='task',object_id_or_key='t-1',id_scope='draft',field_path='deadline',old_value=None,new_value=None,confirmed_at='2026-11-24T08:00:00+08:00')
for field in ('old_value','new_value','id_scope'):
    bad={k:v for k,v in data.items() if k!=field}
    try: UserConfirmation.model_validate(bad)
    except ValueError: pass
    else: raise AssertionError('accepted missing '+field)
valid=UserConfirmation.model_validate(data)
for dumped in (valid.model_dump(),valid.model_dump(exclude_unset=True),json.loads(valid.model_dump_json())):
    assert 'old_value' in dumped and 'new_value' in dumped
    UserConfirmation.model_validate(dumped)
print('PASS: required fields reject; explicit null preserved through model/json round trips.')
