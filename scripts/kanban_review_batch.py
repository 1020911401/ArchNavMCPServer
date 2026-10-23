#!/usr/bin/env python3
"""kanban_review_batch.py — 一次性把所有确认项灌进 Hermes Kanban（单进程，~2s）。

为什么不是每条跑一次 `hermes kanban create`：CLI 每次启动要 import 整个 agent（实测 ~15s/次），
16 条要 4 分钟。这里直接复用 hermes_cli.kanban_db.create_task（和 CLI 同一个实现、同一个 DB、
同一套 idempotency 语义），16 条 1~2 秒。

Usage:
  python kanban_review_batch.py --board <slug> --plan <plan.json> [--json]
plan.json: {"parent": {...create_task kwargs...}, "items": [{...}, ...]}
item 里可带 "parents": ["<parent_id>"]，也支持 "@parent" 占位（表示用本次新建的父任务）。
"""
import argparse
import json
import os
import sys
from pathlib import Path


def find_hermes_agent_dir() -> Path | None:
    env = os.environ.get("HERMES_AGENT_DIR")
    if env and Path(env).is_dir():
        return Path(env)
    home = Path(os.environ.get("HERMES_HOME") or (Path.home() / "AppData" / "Local" / "hermes" if os.name == "nt" else Path.home() / ".hermes"))
    for cand in (home / "hermes-agent", Path.home() / ".hermes" / "hermes-agent"):
        if (cand / "hermes_cli" / "kanban_db.py").is_file():
            return cand
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--board", required=True)
    ap.add_argument("--plan")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--probe", action="store_true", help="只检查能否 import，不写库")
    ap.add_argument("--dump", metavar="TENANT", help="导出该批次（tenant）按状态分组的任务——逐项确认回读用，含评论")
    args = ap.parse_args()

    agent_dir = find_hermes_agent_dir()
    if agent_dir is None:
        print("kanban_review_batch: 找不到 hermes-agent 目录（设 HERMES_AGENT_DIR）", file=sys.stderr)
        return 3
    sys.path.insert(0, str(agent_dir))
    try:
        from hermes_cli import kanban_db as kb
        from hermes_cli import kanban_db_connect as kbc
    except Exception as exc:  # noqa: BLE001
        print(f"kanban_review_batch: import 失败: {exc}", file=sys.stderr)
        return 3
    if args.probe:
        print("ok")
        return 0

    if args.dump is not None:
        out = []
        with kb.scoped_current_board(args.board):
            with kbc.connect_closing() as conn:
                for t in kb.list_tasks(conn, tenant=args.dump, include_archived=True):
                    out.append({
                        "id": t.id, "title": t.title, "status": t.status,
                        "priority": t.priority, "result": t.result,
                        "comments": [{"author": c.author, "body": c.body} for c in kb.list_comments(conn, t.id)],
                    })
        print(json.dumps({"tenant": args.dump, "tasks": out}, ensure_ascii=False))
        return 0

    plan = json.loads(Path(args.plan).read_text(encoding="utf-8")) if args.plan else None
    if plan is None:
        print("kanban_review_batch: 需要 --plan（或改用 --probe / --dump）", file=sys.stderr)
        return 2
    items = list(plan.get("items") or [])
    header_kwargs = dict(plan.get("header") or plan.get("parent") or {})

    created = []
    with kb.scoped_current_board(args.board):
        with kbc.connect_closing() as conn:
            for item in items:
                kw = dict(item)
                kw.setdefault("initial_status", "running")  # 与 `hermes kanban create` 一致
                kw.pop("parents", None)
                task_id = kb.create_task(conn, **kw)
                created.append({"id": task_id, "title": kw.get("title"), "priority": kw.get("priority", 0)})

            header_id = None
            if header_kwargs:
                hkw = dict(header_kwargs)
                parents = hkw.pop("parents", "@items")
                # 依赖方向：条目 → 批次收口卡。反了就是死锁——kanban 要求父任务先完成，
                # 子任务才能 complete（实测 `cannot complete: unsatisfied parent dependencies`），
                # 于是「批次卡当父、条目当子」会让每一条确认项都完不成。
                if parents == "@items":
                    hkw["parents"] = tuple(c["id"] for c in created)
                elif isinstance(parents, list):
                    hkw["parents"] = tuple(parents)
                hkw.setdefault("initial_status", "running")
                header_id = kb.create_task(conn, **hkw)

    out = {"header_id": header_id, "items": created}
    if args.json:
        print(json.dumps(out, ensure_ascii=False))
    else:
        if header_id:
            print(f"header {header_id}")
        for c in created:
            print(f"  {c['id']}  p{c['priority']}  {c['title']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
