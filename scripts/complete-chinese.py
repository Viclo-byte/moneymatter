"""Translate public upstream UI text; never reads deployment secrets or user data."""
import concurrent.futures
import json
import pathlib
import re
import time
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
CACHE = ROOT / '.translation-cache.json'
cache = json.loads(CACHE.read_text()) if CACHE.exists() else {}
base = ROOT / 'packages/frontend/src/i18n/locales/chunks'
token = re.compile(r"\{[^{}]*\}|https?://[^\s<>]+|</?[^>]+>|@:[\w.]+")

def leaves(obj):
    if isinstance(obj, dict):
        for value in obj.values():
            yield from leaves(value)
    elif isinstance(obj, str):
        yield obj

sources = []
for folder in [base / 'en', ROOT / 'packages/backend/src/i18n/locales']:
    files = folder.rglob('*.json') if folder.name == 'en' else [folder / 'en.json']
    for path in files:
        sources.extend(leaves(json.loads(path.read_text())))
sources = list(dict.fromkeys(s for s in sources if re.search('[a-zA-Z]{3}', s)))

def translate(batch):
    protected = []
    all_tokens = []
    for source in batch:
        tokens = []
        def hide(match):
            tokens.append(match.group())
            return f'ZXQ{len(tokens)-1:03d}XQZ'
        protected.append(token.sub(hide, source))
        all_tokens.append(tokens)
    query = [('client', 'dict-chrome-ex'), ('sl', 'en'), ('tl', 'zh-CN')]
    query.extend(('q', value) for value in protected)
    url = 'https://clients5.google.com/translate_a/t?' + urllib.parse.urlencode(query)
    for attempt in range(5):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
            result = json.load(urllib.request.urlopen(req, timeout=40))
            if len(result) != len(batch):
                raise ValueError('Translation count mismatch')
            out = {}
            for source, target, tokens in zip(batch, result, all_tokens):
                if not isinstance(target, str):
                    raise ValueError('Unexpected translation type')
                for i, original in enumerate(tokens):
                    marker = f'ZXQ{i:03d}XQZ'
                    # Reject altered markers instead of damaging interpolation.
                    if target.count(marker) != 1:
                        raise ValueError('Placeholder changed')
                    target = target.replace(marker, original)
                if sorted(token.findall(target)) != sorted(token.findall(source)):
                    raise ValueError('Placeholder mismatch')
                out[source] = target
            return out
        except Exception as error:
            if attempt == 4:
                print('RETRY LATER', str(error), batch[0][:60], flush=True)
                return {}
            time.sleep(2 + attempt * 2)

pending = [s for s in sources if s not in cache]
batches, current, size = [], [], 0
for value in pending:
    cost = len(urllib.parse.quote(value))
    if current and (size + cost > 5000 or len(current) >= 18):
        batches.append(current); current, size = [], 0
    current.append(value); size += cost
if current:
    batches.append(current)
print('Unique strings', len(sources), 'pending', len(pending), 'batches', len(batches), flush=True)
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    for i, result in enumerate(pool.map(translate, batches)):
        cache.update(result)
        CACHE.write_text(json.dumps(cache, ensure_ascii=False, indent=2) + '\n')
        if i % 10 == 0:
            print('Translated', len(cache), '/', len(sources), flush=True)

def localize(source, existing):
    if isinstance(source, dict):
        return {k: localize(v, existing.get(k) if isinstance(existing, dict) else None) for k, v in source.items()}
    if isinstance(source, str):
        if isinstance(existing, str) and re.search('[\u4e00-\u9fff]', existing):
            if sorted(token.findall(existing)) == sorted(token.findall(source)):
                return existing
        return cache.get(source, source)
    return source

for source in (base / 'en').rglob('*.json'):
    target = base / 'zh-CN' / source.relative_to(base / 'en')
    existing = json.loads(target.read_text()) if target.exists() else {}
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(localize(json.loads(source.read_text()), existing), ensure_ascii=False, indent=2) + '\n')
backend = ROOT / 'packages/backend/src/i18n/locales'
target = backend / 'zh-CN.json'
target.write_text(json.dumps(localize(json.loads((backend / 'en.json').read_text()), json.loads(target.read_text())), ensure_ascii=False, indent=2) + '\n')
print('Done; untranslated unique strings:', len([s for s in sources if s not in cache]), flush=True)
