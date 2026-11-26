import sys,json,copy,io,contextlib
from pathlib import Path
sys.path.insert(0,str(Path('contract').resolve()))
from models import FocusSession,TaskSnapshot,Fixture
from generate import load_fixtures,check_fixtures,build_schema,emit_typedefs
from pydantic import ValidationError
fixtures=load_fixtures(); records=[]
f6=next(f for f in fixtures if f.id=='06-focus-v1-running')
base=f6.focus_session.model_dump(mode='json')
for name,payload,model in [
 ('invalid_timer_anchor',dict(base,timer_anchor_at='not-a-date'),FocusSession),
 ('invalid_calendar_anchor',dict(base,timer_anchor_at='2026-02-30T25:90:00+99:99'),FocusSession),
 ('invalid_snapshot_capture',dict(title='task',captured_at='not-a-date'),TaskSnapshot),
 ('invalid_snapshot_deadline',dict(title='task',captured_at='2026-11-20T09:00:00+08:00',deadline_precision='date',deadline_value='2026-02-30'),TaskSnapshot)]:
 try:model.model_validate(payload);accepted=True
 except ValidationError:accepted=False
 records.append({'case':name,'accepted':accepted})

def check_mutation(label,fixture_id,mutator):
 raw=[f.model_dump(mode='json') for f in fixtures]; f=next(f for f in raw if f['id']==fixture_id);mutator(f)
 validated=[Fixture.model_validate(f) for f in raw]
 out=io.StringIO()
 with contextlib.redirect_stdout(out):code=check_fixtures(validated)
 records.append({'case':label,'accepted':code==0,'details':out.getvalue().strip()})
check_mutation('cross_workspace_active_focus','06-focus-v1-running',lambda f:f['focus_session'].update(workspace_id='another-workspace'))
f5=next(f for f in fixtures if f.id=='05-task-and-focus')
check_mutation('action_belongs_to_another_task','06-focus-v1-running',lambda f:f['focus_session'].update(action_id=f5.action.id))
f10=next(f for f in fixtures if f.id=='10-focus-legacy-ended-v0')
check_mutation('plan_shortcut_to_unrelated_ended_focus','07-focus-v1-ended-done',lambda f:f['plan_items'][0].update(focus_session_id=f10.focus_session.id))
checks={'schema_matches_source':json.loads(Path('contract/schema.json').read_text(encoding='utf-8'))==build_schema(),'typedef_matches_source':Path('contract/typedefs.d.ts').read_text(encoding='utf-8')==emit_typedefs(build_schema()['$defs'])}
result={'negative_cases':records,'generation':checks}
Path('output/stage3b0-review-2026-11-20/probe-result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(result,ensure_ascii=False,indent=2))
