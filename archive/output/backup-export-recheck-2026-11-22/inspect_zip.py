import base64
import hashlib
import json
from pathlib import Path
from zipfile import ZipFile

root = Path(__file__).parent
png = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==')
results = {}
for name in ['browser-baseline']:
    with ZipFile(root / (name + '.zip')) as archive:
        manifest = json.loads(archive.read('manifest.json'))
        sources = json.loads(archive.read('data/sources.json'))
        docs = json.loads(archive.read('data/docs.json'))
        checksums = all(len(archive.read(p['path'])) == p['bytes'] and hashlib.sha256(archive.read(p['path'])).hexdigest() == p['sha256'] for p in manifest['payloads'])
        image_sources = [s for s in sources if s['kind'] == 'image']
        results[name] = {
            'checksums_match': checksums,
            'source_count': len(sources), 'doc_count': len(docs),
            'image_matches_independent_constant': archive.read(image_sources[0]['asset_path']) == png if image_sources else None,
            'workspace_ids': sorted({r['workspace_id'] for r in sources + docs}),
            'has_unapproved_field': any('unapproved_field' in d for d in docs),
            'sources_json_bytes': len(archive.read('data/sources.json')),
        }
(root / 'independent-zip-result.json').write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(results, ensure_ascii=True, indent=2))

