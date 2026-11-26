"""Read-only protocol review probes; fictional data, no network or user database."""
import importlib.util
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PROPOSAL = ROOT / 'contract/proposals/assistant-v1'
sys.path.insert(0, str(PROPOSAL))
sys.path.insert(0, str(ROOT))
import models as M
import selftest as S
import generate as G
from contract.models import Deadline

results = []

def accepts(fn):
    try:
        fn()
        return {'accepted': True}
    except ValueError as exc:
        return {'accepted': False, 'error': str(exc)}

for value in ['2026-11-26T09:00+08:00', '2026-11-26T09:00', '2026-11-26T09:00:00.123+08:00']:
    data = dict(value=value, precision='datetime', source='manual', confirmed_at='2026-11-24T10:00:00+08:00')
    old = accepts(lambda: Deadline.model_validate(data))
    new = accepts(lambda: M.ExistingDeadline.model_validate(data))
    results.append({'probe': 'legacy_deadline', 'value': value, 'production_0_4': old, 'proposal': new})
    assert old['accepted'] and new['accepted']

schema = json.loads((PROPOSAL / 'schema.json').read_text(encoding='utf-8'))
for model, prop in [('AssistantModelProposal', 'task_proposals'), ('AssistantProposeResponse', 'payload')]:
    node = schema['$defs'][model]['properties'][prop]
    ts = G.ts_type(node)
    results.append({'probe': 'typescript_discriminated_union', 'model': model, 'field': prop, 'generated_type': ts})
    assert 'unknown' not in ts

ctx = dict(workspace_id='ws', tasks=[dict(id='t-1', workspace_id='ws')],
           actions=[dict(id='a-1', workspace_id='ws', task_id='t-1', done=True)],
           source_ids=['s-1'], note_ids=[], turn_id='turn-1')
work = dict(key='w1', task_ref=dict(kind='existing', id='t-1'),
            action_ref=dict(kind='existing', id='a-1'), deliverable='fictional work', remaining_minutes=40)

def semantic(data):
    S.check_model_semantics(M.AssistantModelProposal.model_validate(data), ctx)

direct = accepts(lambda: semantic(dict(work_items=[work])))
reuse = accepts(lambda: semantic(dict(action_proposals=[dict(op='reuse', key='a-reuse', target_id='a-1', task_ref=dict(kind='existing', id='t-1'))])))
results.append({'probe': 'completed_action', 'direct_work_reference': direct, 'reuse_control': reuse})
assert not direct['accepted'] and not reuse['accepted']

for origin, evidence in [('model', dict(kind='source_excerpt', source_id='unselected-source', excerpt='fictional deadline')),
                         ('user', dict(kind='source_excerpt', source_id='s-1', excerpt='not a user message'))]:
    dl = dict(value='2026-11-27', precision='date', origin=origin, evidence_refs=[evidence])
    update = dict(op='update', key='t-update', target_id='t-1', changes=dict(deadline_candidates=[dl]))
    create = dict(op='create', key='t-new', title='fictional task', deadline_candidates=[dl])
    u = accepts(lambda: semantic(dict(task_proposals=[update])))
    c = accepts(lambda: semantic(dict(task_proposals=[create])))
    results.append({'probe': 'update_deadline_evidence', 'origin': origin, 'update': u, 'create_control': c})
    assert not u['accepted'] and not c['accepted']

# Actual production router with inert adapters; no credentials, network, or shared quota.
sys.path.insert(0, str(ROOT / 'backend'))
from app.model.registry import ModelRouter
from app.model.base import ModelError, ModelProfile
from unittest.mock import patch
attempts = []
class FakeAdapter:
    def __init__(self, name):
        self.name = name
        self.profile = ModelProfile(name=name, protocol='openai', model='fake', api_key_env='UNUSED', retries=1)
    def complete(self, **kwargs):
        attempts.append(self.name)
        raise ModelError('transport', 'fictional failure', True, self.name)

with patch('app.model.registry.time.sleep'), patch('app.model.registry.log_event'):
    try:
        ModelRouter([FakeAdapter('a'), FakeAdapter('b')]).complete(system='', user_text='', image_b64=None, media_type='image/png', budget_s=120)
    except ModelError:
        pass
results.append({'probe': 'analyze_multi_profile_attempts', 'profiles': 2, 'retries_each': 1, 'attempts': attempts, 'count': len(attempts)})
assert len(attempts) == 4

out = Path(__file__).with_name('recheck-results.json')
out.write_text(json.dumps(results, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps(results, ensure_ascii=False, indent=2))
print('All R1-R5 recheck assertions passed; no production files changed.')
