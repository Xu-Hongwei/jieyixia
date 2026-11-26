import json, runpy, sys
sys.path.insert(0, 'E:/qoder/backend')
from app._contract import AssistantProposeRequest
from app.assistant.core import parse_propose_output
from app.model.base import ModelError
h=runpy.run_path('E:/qoder/backend/tests/test_assistant_propose.py')
req=AssistantProposeRequest.model_validate(h['mk_request'](user_message='请拆解报告，我还没有决定截止日期。'))
base=h['proposal_payload']()
for keys in [['w1'],['a1'],['w-ghost']]:
    payload=json.loads(json.dumps(base))
    payload['proposal']['assumptions']=[{'id':'as1','text':'估时是假设','related_keys':keys}]
    try:
        parse_propose_output(json.dumps(payload),req,max_output_bytes=1000000)
        result='accepted'
    except ModelError as e:
        result=e.kind
    print('RELATED_KEYS',keys,result)
payload=json.loads(json.dumps(base))
c=payload['proposal']['task_proposals'][0]['deadline_candidates'][0]
c.update(origin='user',value='2026-12-01',precision='date',basis='explicit',evidence_refs=[{'kind':'user_message','turn_id':req.turn_id,'excerpt':'我明确要求在2026年12月1日之前完成'}])
try:
    res=parse_propose_output(json.dumps(payload),req,max_output_bytes=1000000)
except ModelError as e:
    print('FORGED_USER_DEADLINE rejected',e.kind)
else:
    print('FORGED_USER_DEADLINE accepted',res.payload.proposal.task_proposals[0].deadline_candidates[0].model_dump(mode='json'))
    raise AssertionError('fabricated user-message evidence accepted')
