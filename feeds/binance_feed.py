"""Binance stock-token feed adapter."""
import json, urllib.request

def fetch_price(wrapper: str) -> float:
    body = json.dumps({"jsonrpc": "2.0", "method": "eth_call",
                       "params": [{"to": wrapper, "data": "0x9d9f3c2a"}, "latest"], "id": 1}).encode()
    req = urllib.request.Request("https://bsc-dataseed.binance.org", body, {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        return int(json.loads(resp.read())["result"], 16) / 1e18
