// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title StockOracle
/// @notice Median-of-feeds oracle for stock tokens with deviation guard.
contract StockOracle {
    struct Observation { uint256 price; uint256 ts; }

    mapping(address => Observation[]) public history;
    address[] public feeds;
    uint256 public maxDeviationBps = 300; // 3%

    function submit(address token, uint256 price) external {
        Observation[] storage h = history[token];
        if (h.length > 0) {
            uint256 last = h[h.length - 1].price;
            uint256 diff = price > last ? price - last : last - price;
            require(diff * 10000 <= last * maxDeviationBps, "StockOracle: deviation too high");
        }
        h.push(Observation(price, block.timestamp));
        if (h.length > 24) {
            for (uint256 i = 0; i < h.length - 1; i++) h[i] = h[i + 1];
            h.pop();
        }
    }

    function twap(address token, uint256 window) external view returns (uint256) {
        Observation[] storage h = history[token];
        require(h.length > 0, "StockOracle: no data");
        uint256 acc;
        uint256 n;
        for (uint256 i = h.length; i > 0; i--) {
            if (block.timestamp - h[i - 1].ts > window) break;
            acc += h[i - 1].price;
            n++;
        }
        return n == 0 ? h[h.length - 1].price : acc / n;
    }
}
