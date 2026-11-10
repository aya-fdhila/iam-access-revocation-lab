#!/usr/bin/env python3
"""Generate deterministic PNG charts only from canonical CSV evidence."""

from __future__ import annotations

import argparse
import csv
import os
from collections import defaultdict
from pathlib import Path

os.environ.setdefault("MPLCONFIGDIR", "/tmp/iam-lab-matplotlib")
os.environ.setdefault("SOURCE_DATE_EPOCH", "0")

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from lab import REPO_ROOT

COLORS = {"local": "#0F766E", "introspection": "#2563EB", "cached": "#D97706"}


def read_csv(path: Path) -> list[dict[str, str]]:
    if not path.is_file():
        raise FileNotFoundError(f"missing canonical evidence: {path}")
    with path.open(encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def save(figure: plt.Figure, path: Path) -> None:
    figure.savefig(
        path,
        dpi=160,
        bbox_inches="tight",
        facecolor="white",
        metadata={"Software": "iam-access-revocation-lab"},
    )
    plt.close(figure)


def plot_offboarding(rows: list[dict[str, str]], output: Path) -> None:
    grouped: dict[tuple[str, str, int], list[float]] = defaultdict(list)
    censored: dict[tuple[str, str, int], int] = defaultdict(int)
    for row in rows:
        if row["element"] != "api_authenticated":
            continue
        key = (row["offboarding_mode"], row["validation_mode"], int(row["lifetime_s"]))
        if row["outcome"] == "observed":
            grouped[key].append(float(row["delay_from_t1_s"]))
        else:
            censored[key] += 1
    lifetimes = sorted({key[2] for key in grouped | censored})
    figure, axes = plt.subplots(1, 2, figsize=(11, 4))
    for axis, strategy in zip(axes, ("baseline", "automated"), strict=True):
        for mode in ("local", "introspection", "cached"):
            values = []
            for lifetime in lifetimes:
                samples = grouped[(strategy, mode, lifetime)]
                values.append(sum(samples) / len(samples) if samples else float("nan"))
            axis.plot(lifetimes, values, marker="o", color=COLORS[mode], label=mode)
        axis.set_title(f"{strategy.title()} offboarding")
        axis.set_xlabel("Access-token lifetime (seconds)")
        axis.grid(alpha=0.25)
    axes[0].set_ylabel("Mean rejection delay from T1 (seconds)")
    axes[1].legend(frameon=False)
    figure.suptitle("Observed residual API access")
    figure.tight_layout()
    save(figure, output)


def plot_benchmark(rows: list[dict[str, str]], output: Path) -> None:
    ordered = sorted(rows, key=lambda row: ("local", "introspection", "cached").index(row["mode"]))
    modes = [row["mode"] for row in ordered]
    p50 = [float(row["latency_p50_ms"]) for row in ordered]
    p95 = [float(row["latency_p95_ms"]) for row in ordered]
    x = list(range(len(modes)))
    figure, axis = plt.subplots(figsize=(7, 4))
    axis.bar([value - 0.18 for value in x], p50, width=0.36, label="p50", color="#0F766E")
    axis.bar([value + 0.18 for value in x], p95, width=0.36, label="p95", color="#D97706")
    axis.set_xticks(x, modes)
    axis.set_ylabel("Latency (milliseconds)")
    axis.set_title("Validation-mode request latency")
    axis.grid(axis="y", alpha=0.25)
    axis.legend(frameon=False)
    figure.tight_layout()
    save(figure, output)


def plot_matrix(rows: list[dict[str, str]], output: Path) -> None:
    cases = list(
        dict.fromkeys(
            (row["case_type"], row["profile"], row["method"], row["route"]) for row in rows
        )
    )
    matrix = [
        [
            1
            if next(
                row
                for row in rows
                if (row["case_type"], row["profile"], row["method"], row["route"]) == case
                and row["mode"] == mode
            )["outcome"]
            == "pass"
            else 0
            for mode in ("local", "introspection", "cached")
        ]
        for case in cases
    ]
    labels = [f"{profile} · {method} {route}" for _case_type, profile, method, route in cases]
    figure, axis = plt.subplots(figsize=(11, max(8, len(cases) * 0.27)))
    axis.imshow(
        matrix,
        aspect="auto",
        cmap=matplotlib.colors.ListedColormap(["#B91C1C", "#15803D"]),
        vmin=0,
        vmax=1,
    )
    axis.set_xticks(range(3), ("local", "introspection", "cached"))
    axis.set_yticks(range(len(cases)), labels, fontsize=6)
    axis.set_title("Complete profile x route x validation-mode agreement")
    for row_index, row in enumerate(matrix):
        for column_index, value in enumerate(row):
            axis.text(
                column_index,
                row_index,
                "PASS" if value else "FAIL",
                ha="center",
                va="center",
                color="white",
                fontsize=8,
            )
    figure.tight_layout()
    save(figure, output)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--results", type=Path, default=REPO_ROOT / "results")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    args.results.mkdir(parents=True, exist_ok=True)
    plot_matrix(read_csv(args.results / "matrix.csv"), args.results / "matrix.png")
    plot_offboarding(read_csv(args.results / "offboarding.csv"), args.results / "offboarding.png")
    plot_benchmark(read_csv(args.results / "bench.csv"), args.results / "benchmark.png")
    print("generated matrix.png, offboarding.png, and benchmark.png from canonical CSV evidence")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
