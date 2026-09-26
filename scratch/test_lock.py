import asyncio
from dataclasses import dataclass, field

@dataclass
class Handle:
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

async def main():
    h = Handle()
    print("Lock created:", h.lock)

asyncio.run(main())
