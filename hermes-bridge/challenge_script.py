#!/usr/bin/env python3
"""
ChallengeScript v2 — 8+ bugs seeded for review.
This script compiles and runs, but produces wrong output.
Find ALL bugs, rank by severity, explain why, then fix them.
"""
import time, threading, random
from typing import List

# ── BUG #1: mutable class variable ──
# tasks = [] is shared across ALL TaskRegistry calls
class TaskRegistry:
    tasks = []

    @classmethod
    def register(cls, name, fn):
        cls.tasks.append((name, fn))

    @classmethod
    def run_all(cls):
        return {name: fn() for name, fn in cls.tasks}


# ── BUG #2: closure captures loop var i by reference ──
# All workers see the final value of i after loop ends
def make_workers(count):
    workers = []
    for i in range(count):
        def worker(n):
            return n ** i
        workers.append(worker)
    return workers


# ── BUG #3: mutable default arg ──
# buffer=[] is created once at def time, shared across instances
class DataProcessor:
    def __init__(self, name: str, buffer: List[int] = []):
        self.name = name
        self.buffer = buffer

    def feed(self, *items):
        self.buffer.extend(items)

    def flush(self) -> List[int]:
        data = list(self.buffer)
        self.buffer.clear()
        return data


# ── BUG #4: lock not released on early return ──
# If amount < 0, the lock is acquired but never released → deadlock
class ThreadSafeCounter:
    def __init__(self):
        self.value = 0
        self.lock = threading.Lock()

    def increment(self, amount):
        self.lock.acquire()
        if amount < 0:
            return self.value
        self.value += amount
        self.lock.release()
        return self.value


# ── BUG #5: singleton __init__ clobbers class var ──
# Config.db_url is set every __init__ call, not just first time
class Config:
    _instance = None
    _initialized = False

    def __new__(cls, *args, **kwargs):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def __init__(self, db_url="sqlite:///dev.db", api_key=""):
        if not self._initialized:
            self.db_url = db_url
            self.api_key = api_key
            Config._initialized = True
        Config.db_url = db_url  # clobbers class var


# ── BUG #6: retry returns None on total failure ──
# Caller can't distinguish "all attempts failed" from a valid None result
class RetryHandler:
    def __init__(self, max_attempts=3):
        self.max_attempts = max_attempts

    def execute(self, fn, *args, **kwargs):
        last_exc = None
        for attempt in range(self.max_attempts):
            try:
                return fn(*args, **kwargs)
            except Exception as e:
                last_exc = e
                time.sleep(0.1 * (attempt + 1))
        return None


# ── BUG #7: float equality comparison ──
# IEEE 754: 0.1 * 10 != 1.0, so validate_ratio(1.0) returns False
def validate_ratio(ratio):
    if ratio == 1.0:
        return True
    bounds = [i * 0.1 for i in range(11)]
    return any(abs(ratio - b) < 1e-12 for b in bounds)


# ── BUG #8: swallowed GeneratorExit ──
# generator.close() is silently swallowed → cleanup never runs
def safe_generator(data):
    try:
        for item in data:
            yield item
    except GeneratorExit:
        pass  # silently swallows close — no cleanup
    except:
        pass  # swallows everything
    finally:
        for x in data:
            pass  # never reached because close is swallowed and gen stays alive


# ── BUG #9 (BONUS): monkey-patch replaces buffer ref ──
# patched_flush sets self.buffer = [] instead of self.buffer.clear()
# This replaces the reference, so other instances sharing the original list aren't affected
# BUT it ALSO means dp1's old buffer isn't cleared — double bug
original_flush = DataProcessor.flush
def patched_flush(self):
    data = list(self.buffer)
    self.buffer = []  # replaces ref — shared instances still see old list
    return data
DataProcessor.flush = patched_flush


# ── helper tasks for demo ──
@TaskRegistry.register("task_a", lambda: 42)
@TaskRegistry.register("task_b", lambda: "hello")
def _task_placeholder():
    pass  # decorators need a function to decorate


if __name__ == "__main__":
    print("=== CHALLENGE SCRIPT DEMO ===\n")

    # 1 — TaskRegistry re-runs: tasks list accumulates across calls
    results = TaskRegistry.run_all()
    print(f"1. TaskRegistry: {results}")

    # 2 — closure workers: i is 2 (final loop val) for all
    workers = make_workers(3)
    print(f"2. w[0](2)={workers[0](2)}  w[1](2)={workers[1](2)}  w[2](2)={workers[2](2)}")

    # 3 — DataProcessor: dp1 and dp2 share same default buffer list
    dp1 = DataProcessor("dp1")
    dp2 = DataProcessor("dp2")
    dp1.feed(1, 2, 3, 4)
    dp2.feed(5, 6)
    print(f"3. dp1 flush: {dp1.flush()}")
    print(f"4. dp2 flush: {dp2.flush()}")

    # 4 — ThreadSafeCounter: lock stuck on negative input
    tsc = ThreadSafeCounter()
    r = tsc.increment(-5)
    print(f"5. counter(-5): {r}")
    tsc.increment(10)
    print(f"6. counter(10): {tsc.value}")
    stuck = not tsc.lock.acquire(blocking=False)
    print(f"7. lock stuck?: {stuck}")
    if stuck:
        tsc.lock.release()

    # 5 — Config singleton: db_url gets overwritten
    cfg1 = Config(db_url="postgres://localhost/db")
    cfg2 = Config()
    print(f"8. cfg1.db_url={cfg1.db_url}  cfg2.db_url={cfg2.db_url}")

    # 6 — RetryHandler: silent None
    def flaky():
        if random.random() < 0.8:
            raise ConnectionError("timeout")
        return "ok"
    result = RetryHandler(3).execute(flaky)
    print(f"9. retry result: {result}")

    # 7 — float precision
    accum = sum(0.1 for _ in range(10))
    print(f"10. validate_ratio({accum}): {validate_ratio(accum)}")

    # 8 — close swallowed
    gen = safe_generator([1, 2, 3])
    next(gen)
    gen.close()
    try:
        nxt = next(gen)
        print(f"11. safe_generator after close: {nxt}")
    except StopIteration:
        print("11. safe_generator raised StopIteration (wrong!)")
