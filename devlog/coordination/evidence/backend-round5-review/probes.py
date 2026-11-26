"""Independent, local-only acceptance probes; no product source changes."""
import base64
import json
import os
import pathlib
import struct
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = pathlib.Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / 'backend'))
for key in list(os.environ):
    if key.startswith('JXL_'):
        del os.environ[key]
os.environ['JXL_PROVIDER'] = 'fixture'

print('START_IMPORTS', flush=True)
import httpx
from app._contract import AnalyzeRequest
from app.config import get_settings
from app.errors import ApiFault
from app.model.adapters import OpenAICompatibleAdapter
from app.model.base import ModelProfile
from app.model.core import _normalize_node
from app.model.registry import ModelRouter, load_profiles
from app.providers import ModelProvider
from app.validation import check_calendar_datetime, inspect_image

def report(name, **data):
    print(json.dumps({'probe': name, **data}, ensure_ascii=False), flush=True)

try:
    inspect_image('data:image/png;base64', max_bytes=10000, max_pixels=10000, max_side=100)
    report('malformed_data_url', accepted=True)
except Exception as exc:
    report('malformed_data_url', accepted=False, kind=type(exc).__name__, status=getattr(exc,'status_code',None))

minimal_png = b'\x89PNG\r\n\x1a\n' + struct.pack('>I', 13) + b'IHDR' + struct.pack('>II', 1, 1)
encoded = base64.b64encode(minimal_png).decode()
try:
    media = inspect_image(encoded, max_bytes=10000, max_pixels=10000, max_side=100)
    report('truncated_png', bytes=len(minimal_png), accepted=True, mime=media, missing='IHDR remainder, CRC, IDAT, IEND')
except ApiFault as exc:
    report('truncated_png', accepted=False, status=exc.status_code)

calls = []
good_content = json.dumps({'content_type': 'reference', 'fields': [{'key':'title','value':'T','raw':'T','status':'candidate'}]})
def mock(request):
    calls.append(1)
    return httpx.Response(200, json={'choices':[{'message':{'content':good_content}}]})
profile = ModelProfile(name='offline-probe', protocol='openai', model='fake', api_key_env='DUMMY', base_url='http://127.0.0.1:1', retries=0)
provider = ModelProvider(ModelRouter([OpenAICompatibleAdapter(profile, 'dummy', httpx.MockTransport(mock))]))
try:
    result = provider.analyze(AnalyzeRequest(source_id='probe', kind='image', image_base64=encoded, captured_at='2026-11-18T12:00:00+08:00'))
    report('truncated_png_provider', calls=len(calls), success=True)
except Exception as exc:
    report('truncated_png_provider', calls=len(calls), success=False, kind=type(exc).__name__)

try:
    check_calendar_datetime('2026-11-18T12:00:00+08:75', 'captured_at')
    report('offset_minutes_75', accepted=True)
except ApiFault:
    report('offset_minutes_75', accepted=False)
try:
    normalized = _normalize_node({'raw':'2026-11-18T12:00:00+08:75','value':'2026-11-18T12:00:00+08:75','role':'submission_deadline','basis':'explicit'})
    report('node_offset_minutes_75', accepted=True, value=normalized['value'])
except Exception as exc:
    report('node_offset_minutes_75', accepted=False, kind=type(exc).__name__)

os.environ['JXL_ANALYZE_BUDGET_S']='NaN'
get_settings.cache_clear()
try:
    report('nan_budget', accepted=True, value=str(get_settings().analyze_budget_s))
except Exception as exc:
    report('nan_budget', accepted=False, kind=type(exc).__name__)
del os.environ['JXL_ANALYZE_BUDGET_S']
get_settings.cache_clear()
for value in ['-1','abc']:
    os.environ['JXL_MAX_BODY_BYTES']=value
    get_settings.cache_clear()
    try:
        report('body_limit_config', input=value, accepted=True, value=get_settings().max_body_bytes)
    except Exception as exc:
        report('body_limit_config', input=value, accepted=False, kind=type(exc).__name__)
del os.environ['JXL_MAX_BODY_BYTES']
get_settings.cache_clear()

os.environ['JXL_MODELS']=json.dumps([{'name':'bad-base','protocol':'openai','model':'fake','api_key_env':'DUMMY','base_url':123}])
try:
    report('numeric_base_url', accepted=bool(load_profiles()))
except Exception as exc:
    report('numeric_base_url', accepted=False, kind=type(exc).__name__)
del os.environ['JXL_MODELS']

wire = json.dumps({'choices':[{'message':{'content':good_content}}]}).encode()
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass
    def do_POST(self):
        self.rfile.read(int(self.headers.get('Content-Length','0')))
        self.send_response(200)
        self.send_header('Content-Type','application/json')
        self.send_header('Content-Length',str(len(wire)))
        self.end_headers()
        # Each receive gap is below the read timeout; total duration exceeds budget.
        try:
            for i in range(0, len(wire), 10):
                self.wfile.write(wire[i:i+10])
                self.wfile.flush()
                time.sleep(0.06)
        except (BrokenPipeError, ConnectionResetError):
            pass

server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
thread=threading.Thread(target=server.serve_forever,daemon=True)
thread.start()
profile=ModelProfile(name='local-drip',protocol='openai',model='fake',api_key_env='DUMMY',base_url=f'http://127.0.0.1:{server.server_port}',timeout_s=10,retries=0)
router=ModelRouter([OpenAICompatibleAdapter(profile,'dummy')])
start=time.monotonic()
try:
    result,name=router.complete(system='s',user_text='u',image_b64=None,media_type='image/png',budget_s=0.3)
    report('real_http_drip', budget_s=0.3, elapsed_s=round(time.monotonic()-start,3), success=True, result_chars=len(result))
except Exception as exc:
    report('real_http_drip', budget_s=0.3, elapsed_s=round(time.monotonic()-start,3), success=False, kind=type(exc).__name__, model_error_kind=getattr(exc,'kind',None))
finally:
    server.shutdown()
    server.server_close()
    thread.join(timeout=2)
