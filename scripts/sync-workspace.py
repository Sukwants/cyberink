"""Copy reviewable source artifacts to the Windows workspace; never run the app there."""
from pathlib import Path
import shutil
import sys
source = Path(__file__).resolve().parent.parent
target = Path(sys.argv[1]).resolve()
if not target.is_dir() or target == source or source in target.parents:
    raise SystemExit('Supply an existing separate review workspace')
excluded = {'node_modules', 'dist', '.data', '.test-data', '__pycache__', '.git'}
private = {'.env', '.env.test', '.local-dev-credentials.txt', '.audit.json', '.test-data-audit.json'}
count = 0
for item in source.rglob('*'):
    relative = item.relative_to(source)
    if any(part in excluded for part in relative.parts) or item.name in private or (item.name.startswith(".env") and not item.name.endswith(".example")) or not item.is_file():
        continue
    output = target / relative
    output.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(item, output)
    count += 1
print('Copied ' + str(count) + ' reviewable source/artifact files; dependencies, mail data and DB credentials stay in WSL')
