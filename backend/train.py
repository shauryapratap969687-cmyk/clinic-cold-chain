"""CLI: python -m backend.train [--days 240 --seed 42]."""

from __future__ import annotations

import argparse
import json

from .model import train_and_persist


def main() -> None:
    parser = argparse.ArgumentParser(description="Train the synthetic cold-chain risk model")
    parser.add_argument("--days", type=int, default=240, choices=range(180, 366))
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()
    metrics = train_and_persist(days=args.days, seed=args.seed)
    print(json.dumps({"rows": metrics["dataset"]["rows"], "positive_rate": metrics["prevalence"],
                      "pr_auc": metrics["pr_auc"], "f2": metrics["f2"]}, indent=2))


if __name__ == "__main__":
    main()
