import json, runpy, sys
sys.path.insert(0, 'E:/qoder/backend')
from app._contract import AssistantProposeRequest
from app.assistant.core import parse_propose_output
from app.assistant.semantics import _user_authored_segments
from app.model.base import ModelError
h=runpy.run_path('E:/qoder/backend/tests/test_assistant_propose.py')
message='原始要求：每天45分钟，截止尚未决定。\n\n此前的澄清问题与我的回答：\n问：请确认截止日期。\n参考回答：\n答：截止设为2026-12-01\n答：不要设截止日期\n\n请结合以上回答继续生成方案。'
req=AssistantProposeRequest.model_validate(h['mk_request'](user_message=message))
payload=h['proposal_payload']()
c=payload['proposal']['task_proposals'][0]['deadline_candidates'][0]
c.update(origin='user',value='2026-12-01',precision='date',basis='explicit',evidence_refs=[{'kind':'user_message','turn_id':req.turn_id,'excerpt':'截止设为2026-12-01'}])
print('USER_SEGMENTS',_user_authored_segments(message))
try: res=parse_propose_output(json.dumps(payload),req,max_output_bytes=1000000)
except ModelError as e: print('MODEL_EXAMPLE rejected',e.kind)
else:
    print('MODEL_EXAMPLE accepted',res.payload.proposal.task_proposals[0].deadline_candidates[0].model_dump(mode='json'))
    raise AssertionError('model example became user evidence')
