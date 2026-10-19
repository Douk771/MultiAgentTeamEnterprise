#!/usr/bin/env python3
"""Сводка по метрикам циклов build-app-implement.js.

Использование:
    python3 tools/summarize_metrics.py [файл.jsonl ...]
Без аргументов читает все файлы из ~/.multiagent-metrics/*.jsonl.
Только стандартная библиотека. Битые строки пропускаются с предупреждением.
"""
import glob, json, os, sys
from collections import defaultdict
from statistics import mean, median

def load(paths):
    rows = []
    for p in paths:
        with open(p, encoding='utf-8') as f:
            for n, line in enumerate(f, 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    r = json.loads(line)
                    r['_file'] = os.path.basename(p)
                    rows.append(r)
                except json.JSONDecodeError:
                    print(f'! {p}:{n}: не JSON, пропущено', file=sys.stderr)
    return rows

def fmt(x):
    return '—' if x is None else f'{x:,.0f}'.replace(',', ' ')

def stats(vals):
    vals = [v for v in vals if isinstance(v, (int, float))]
    return (len(vals), mean(vals), median(vals), max(vals)) if vals else (0, None, None, None)

def main():
    paths = sys.argv[1:] or sorted(glob.glob(os.path.expanduser('~/.multiagent-metrics/*.jsonl')))
    if not paths:
        sys.exit('Нет файлов метрик (~/.multiagent-metrics/*.jsonl). Передайте путь аргументом.')
    rows = load(paths)
    if not rows:
        sys.exit('Файлы пусты.')

    print(f'Прогонов: {len(rows)}  (файлов: {len(paths)}, период: {min(r.get("ts","?") for r in rows)[:10]} … {max(r.get("ts","?") for r in rows)[:10]})\n')

    by_size = defaultdict(list)
    for r in rows:
        by_size[r.get('size', 'normal')].append(r)

    print('== По размеру задачи ==')
    print(f'{"size":8} {"прогонов":>8} {"успешных":>9} {"токены ср.":>12} {"медиана":>10} {"макс.":>10} {"fix ср.":>8}')
    for size, rs in sorted(by_size.items()):
        ok = sum(1 for r in rs if not r.get('blocked'))
        n, avg, med, mx = stats([r.get('metrics', {}).get('totalSpent') for r in rs])
        fix = [r.get('metrics', {}).get('fixAttempts') for r in rs if r.get('metrics', {}).get('fixAttempts') is not None]
        print(f'{size:8} {len(rs):>8} {ok:>9} {fmt(avg):>12} {fmt(med):>10} {fmt(mx):>10} {(f"{mean(fix):.2f}" if fix else "—"):>8}')

    print('\n== Токены по этапам (среднее по прогонам, где этап был) ==')
    phases = defaultdict(list)
    for r in rows:
        for k, v in (r.get('metrics', {}).get('phases') or {}).items():
            phases[k].append(v)
    total_avg = sum(mean(v) for v in phases.values()) or 1
    for k, v in sorted(phases.items(), key=lambda kv: -mean(kv[1])):
        print(f'{k:34} {fmt(mean(v)):>12}  {mean(v) / total_avg * 100:5.1f}%  (n={len(v)})')

    print('\n== Где останавливаются ==')
    blocked = defaultdict(int)
    for r in rows:
        blocked[r.get('blocked') or 'ok'] += 1
    for k, v in sorted(blocked.items(), key=lambda kv: -kv[1]):
        print(f'{k:20} {v:>4}  ({v / len(rows) * 100:.0f}%)')

    skipped = [r['metrics']['mergeChecksSkipped'] for r in rows if r.get('metrics', {}).get('mergeChecksSkipped') is not None]
    if skipped:
        print(f'\nПроверки после мерджа develop пропущены: {sum(skipped)} из {len(skipped)} прогонов')

    print('\n== Качество ==')
    for key, title in (('reviewFindings', 'находок ревью на прогон'), ('qaNewBugs', 'новых багов QA на прогон')):
        vals = [r.get(key) for r in rows if r.get(key) is not None]
        if vals:
            print(f'{title}: ср. {mean(vals):.2f}, макс. {max(vals)}')

if __name__ == '__main__':
    main()
