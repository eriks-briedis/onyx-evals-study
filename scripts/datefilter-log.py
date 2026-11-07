#!/usr/bin/env python3
"""What the version-filter patch did during a run, from the api_server log.

The patch (onyx-patches/version-filter) logs one line per search when it extracts an as-at
date and one when it picks the versions in force. This counts them between two instants, so a
run's queue log (start/end lines in UTC) gives the window.

    python3 scripts/datefilter-log.py --since 2026-11-03T08:00:00Z --until 2026-11-03T08:40:00Z
"""
import argparse, collections, re, subprocess

AS_AT = re.compile(r"as-at date: (\S+)")
PICK = re.compile(r"version filter: in force on (\S+): (.*)$")
NONE = re.compile(r"as-at date: none stated")
TODAY = re.compile(r"as-at date: none stated; using today \((\S+)\)")
EMPTY = re.compile(r"version filter: no labelled version in force on (\S+)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--since', required=True)
    ap.add_argument('--until', required=True)
    ap.add_argument('--container', default='onyx-api_server-1')
    a = ap.parse_args()
    log = subprocess.run(['docker', 'logs', '--since', a.since, '--until', a.until, a.container],
                         capture_output=True, text=True).stdout + '\n'
    log += subprocess.run(['docker', 'logs', '--since', a.since, '--until', a.until, a.container],
                          capture_output=True, text=True).stderr
    dates, picks, none, empty, today = collections.Counter(), collections.Counter(), 0, collections.Counter(), collections.Counter()
    for line in log.splitlines():
        if m := PICK.search(line):
            picks[(m.group(1), m.group(2).strip())] += 1
        elif m := EMPTY.search(line):
            empty[m.group(1)] += 1
        elif m := TODAY.search(line):
            today[m.group(1)] += 1
        elif NONE.search(line):
            none += 1
        elif m := AS_AT.search(line):
            dates[m.group(1)] += 1
    print(f'as-at date extracted: {sum(dates.values())} searches; none stated, answered as at today: {sum(today.values())}; none stated, stock filter: {none}')
    for d, n in sorted(today.items()):
        print(f'  today = {d}: {n}')
    for d, n in sorted(dates.items()):
        print(f'  {d}: {n}')
    print(f'version picks: {sum(picks.values())} searches')
    for (d, v), n in sorted(picks.items()):
        print(f'  {d}: {v}  x{n}')
    for d, n in sorted(empty.items()):
        print(f'  no version in force on {d}: x{n}')


if __name__ == '__main__':
    main()
