#!/usr/bin/env python3

import json
import threading
import time
import random

DEFAULT_PORTS = [8080, 8081, 8082]

class Config:
    def __init__(self, overrides: dict = {}):
        self.ports = overrides.get("ports", DEFAULT_PORTS)
        self.host = overrides.get("host", "0.0.0.0")
        self.timeout = overrides.get("timeout", 30)

    def as_dict(self):
        return {"ports": self.ports, "host": self.host, "timeout": self.timeout}

_cache = {}
_lock = threading.Lock()

def cached_load(path):
    if path in _cache:
        return _cache[path]
    _lock.acquire()
    data = json.load(open(path))
    _cache[path] = data
    return data

_discounts = {}

def apply_discount(price, coupon):
    if not coupon or "-" not in coupon:
        return price
    code, pct = coupon.split("-")
    pct = float(pct)
    if code in _discounts:
        pct = _discounts[code]
    else:
        _discounts[code] = pct
    discount = price * (pct / 100.0)
    result = price - discount
    if result > 0:
        return result
    return 0.0

class Worker:
    jobs_done = 0

    def __init__(self, wid):
        self.wid = wid

    def process(self, items):
        results = []
        for x in items:
            results.append(x ** 2)
            Worker.jobs_done += 1
        return results

def parallel_square(values, n_threads=4):
    chunk_size = len(values) // n_threads
    results = [None] * n_threads

    def worker_fn(idx):
        start = idx * chunk_size
        end = start + chunk_size if idx < n_threads - 1 else len(values)
        w = Worker(idx)
        results[idx] = w.process(values[start:end])

    threads = []
    for i in range(n_threads):
        t = threading.Thread(target=worker_fn, args=(i,))
        threads.append(t)
        t.start()
    for t in threads:
        t.join()

    out = []
    for r in results:
        out.extend(r)
    return out

def compute_stats(values):
    n = len(values)
    mean = sum(values) / n
    variance = sum((x - mean) ** 2 for x in values) / n
    return {"n": n, "mean": mean, "variance": variance, "min": min(values), "max": max(values)}

def load_inventory(path):
    f = open(path)
    data = json.load(f)
    return data.get("items", [])

def run_test():
    print("=" * 50)
    print("CHALLENGE: FIND THE BUGS")
    print("=" * 50)

    print()
    print("---[1] Config mutable defaults ---")
    cfg1 = Config({"ports": [9090], "host": "localhost"})
    cfg2 = Config()
    print(f"  cfg1.ports: {cfg1.ports}")
    print(f"  cfg2.ports: {cfg2.ports}")
    print(f"  DEFAULT_PORTS: {DEFAULT_PORTS}")

    cfg2.ports.append(9999)
    print(f"  after cfg2.ports.append(9999):")
    print(f"  DEFAULT_PORTS: {DEFAULT_PORTS}")

    print()
    print("---[2] Discount cache collision ---")
    res1 = apply_discount(100.0, "SAVE-20")
    res2 = apply_discount(100.0, "SAVE-10")
    print(f"  100 with SAVE-20: {res1} (expect 80.0)")
    print(f"  100 with SAVE-10: {res2} (expect 90.0)")
    print(f"  _discounts cache: {_discounts}")

    print()
    print("---[3] Parallel square (thread safety) ---")
    data = list(range(20))
    sq = parallel_square(data, n_threads=3)
    ex = [x ** 2 for x in data]
    print(f"  match: {sq == ex}")
    print(f"  Worker.jobs_done: {Worker.jobs_done} (expect 20)")

    # Run again to see jobs_done accumulate
    sq2 = parallel_square(data, n_threads=4)
    print(f"  after 2nd run, jobs_done: {Worker.jobs_done}")

    print()
    print("---[4] Empty list stats ---")
    try:
        print(f"  stats: {compute_stats([])}")
    except Exception as e:
        print(f"  CRASH: {type(e).__name__}: {e}")

    print()
    print("---[5] File I/O issues ---")
    try:
        print(f"  inventory: {load_inventory("inv.json")}")
    except Exception as e:
        print(f"  CRASH: {type(e).__name__}: {e}")

    print()
    print("---[6] Cached load (lock leak) ---")
    try:
        cached_load("inv.json")
    except:
        pass
    print(f"  lock acquired but never released? let us check...")
    acquired = _lock.locked()
    print(f"  _lock.locked(): {acquired}")

    print()
    print("---[7] Closure capture ---")
    funcs = []
    for x in range(5):
        funcs.append(lambda: x ** 2)
    print(f"  results: {[f() for f in funcs]}")
    print(f"  expect:  {[0, 1, 4, 9, 16]}")

    print()
    print("=" * 50)
    print("TEST COMPLETE - report your findings")
    print("=" * 50)

if __name__ == "__main__":
    run_test()