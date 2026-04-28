#!/usr/bin/env python3
"""Batch rename files in a directory by regex.

Receives a JSON payload via stdin, e.g.:
  {"inputs": {"dir": "...", "pattern": "...", "replacement": "...", "dry_run": true}}
"""
import json
import os
import re
import sys


def emit(kind: str, payload: dict) -> None:
    print(f"@@runnerx {kind} {json.dumps(payload, ensure_ascii=False)}", flush=True)


def main() -> int:
    raw = sys.stdin.read()
    body = json.loads(raw)
    inputs = body.get("inputs", {})
    target_dir = inputs["dir"]
    pattern = re.compile(inputs["pattern"])
    replacement = inputs["replacement"]
    dry_run = bool(inputs.get("dry_run", True))

    if not os.path.isdir(target_dir):
        emit("log", {"level": "error", "message": f"不是目录: {target_dir}"})
        return 1

    entries = sorted(os.listdir(target_dir))
    total = len(entries)
    rows = []
    changed = 0
    for i, name in enumerate(entries, 1):
        src = os.path.join(target_dir, name)
        if not os.path.isfile(src):
            continue
        new_name, n = pattern.subn(replacement, name)
        if n == 0 or new_name == name:
            continue
        dst = os.path.join(target_dir, new_name)
        rows.append([name, new_name, "preview" if dry_run else "renamed"])
        if not dry_run:
            os.rename(src, dst)
        changed += 1
        emit("progress", {"value": i / max(total, 1), "message": f"{name} → {new_name}"})

    emit(
        "result",
        {
            "type": "table",
            "title": f"{'预览' if dry_run else '已重命名'} {changed} 个文件",
            "columns": ["原文件名", "新文件名", "状态"],
            "rows": rows,
        },
    )
    print(f"完成。处理 {changed}/{total} 个文件。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
