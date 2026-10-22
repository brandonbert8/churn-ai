"""Extract only inference files from the project-owned Colab archive."""
from pathlib import Path
import zipfile

required = {
    'manifest.json', 'labels.json', 'tfidf_logistic.joblib',
    'beto/config.json', 'beto/model.safetensors', 'beto/vocab.txt',
    'beto/tokenizer.json', 'beto/tokenizer_config.json', 'beto/special_tokens_map.json',
}
with zipfile.ZipFile('tigo_pln_modelo.zip') as archive:
    entries = {entry.filename: entry for entry in archive.infolist()}
    missing = required - entries.keys()
    if missing:
        raise SystemExit(f'Exportación incompleta: {sorted(missing)}')
    if sum(entries[name].file_size for name in required) > 1_000_000_000:
        raise SystemExit('Exportación demasiado grande para este prototipo')
    target = Path('.mastra/models/tigo')
    for name in sorted(required):
        destination = target / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        with archive.open(entries[name]) as source, destination.open('wb') as output:
            while chunk := source.read(1024 * 1024):
                output.write(chunk)
print('Artefactos preparados en .mastra/models/tigo')
