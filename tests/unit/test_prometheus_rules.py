from __future__ import annotations

from itertools import product

import pytest

from tests.evidence import EXPECTED_LIFETIMES, EXPECTED_MODES, EXPECTED_STRATEGIES
from tests.prometheus_rules import METRIC_NAME, render_rules


def complete_rows() -> list[dict[str, str]]:
    return [
        {
            "element": "api_authenticated",
            "outcome": "observed",
            "offboarding_mode": strategy,
            "validation_mode": mode,
            "lifetime_s": str(lifetime),
            "delay_from_t1_s": str(repetition),
        }
        for strategy, mode, lifetime, repetition in product(
            EXPECTED_STRATEGIES, EXPECTED_MODES, EXPECTED_LIFETIMES, (1, 2, 3)
        )
    ]


def test_rules_are_complete_bounded_and_deterministic() -> None:
    evidence = complete_rows()
    rendered = render_rules(evidence)
    assert rendered == render_rules(list(reversed(evidence)))
    assert rendered.count(f"record: {METRIC_NAME}") == 18
    assert rendered.count("expr: 2.000") == 18
    assert "username" not in rendered
    assert "token" not in rendered


def test_rules_refuse_incomplete_or_unknown_labels() -> None:
    evidence = complete_rows()
    with pytest.raises(ValueError):
        render_rules(evidence[:-1])
    evidence[0]["validation_mode"] = "surprise"
    with pytest.raises(ValueError):
        render_rules(evidence)
