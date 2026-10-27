"""The load model: agreement with the front end, and the properties the plan says must always hold."""

from __future__ import annotations

import json
import typing
from pathlib import Path

import pytest

from app.schemas import CampaignKey
from app.simulation import model as m

GOLDEN = json.loads((Path(__file__).parent / "golden" / "model_golden.json").read_text())
# The JavaScript keeps its results in Float32Array, so its values carry about seven significant digits.
FLOAT32 = {"rel": 1e-6, "abs": 1e-6}


def scaled(values: tuple[float, ...], peak: float) -> list[float]:
    return [v * peak for v in values]


@pytest.mark.parametrize(
    "case",
    GOLDEN["cases"],
    ids=lambda c: f"{c['archetype']}-{c['day']}-{'+'.join(c['campaigns']) or 'baseline'}",
)
def test_matches_the_front_end(case: dict[str, typing.Any]) -> None:
    """Same inputs, same hourly kW as web/app/app.js. Regenerate the golden file if the model there changes."""
    profile = m.unit_profile(case["archetype"], case["campaigns"], case["day"])
    peak = GOLDEN["peak_kw"]
    if not case["campaigns"]:
        assert scaled(profile.baseline, peak) == pytest.approx(case["baseline"], **FLOAT32)
        return
    for band in m.BANDS:
        assert scaled(profile.cases[band], peak) == pytest.approx(case[band], **FLOAT32), band


def test_carbon_curve_matches_the_front_end() -> None:
    assert [m.carbon_intensity(h) for h in range(24)] == pytest.approx(GOLDEN["carbon_intensity"], rel=1e-9)
    assert [m.carbon_index(h) for h in range(24)] == pytest.approx(GOLDEN["carbon_index"], rel=1e-9)


def test_golden_covers_every_archetype_and_day() -> None:
    covered = {(c["archetype"], c["day"]) for c in GOLDEN["cases"]}
    assert covered == {(a, d) for a in m.ARCHETYPES for d in ("weekday", "weekend")}


def test_campaign_keys_match_the_request_schema() -> None:
    assert typing.get_args(CampaignKey) == m.CAMPAIGN_KEYS


def test_every_archetype_has_a_shape_for_every_component() -> None:
    for key in m.ARCHETYPES:
        assert set(m.SHAPES[key]) == set(m.COMPONENTS), key
        assert sum(m.ARCHETYPES[key].mix) == pytest.approx(1.0), key


# ---------------------------------------------------------------- properties


@pytest.mark.parametrize("archetype", sorted(m.ARCHETYPES))
@pytest.mark.parametrize("day", ["weekday", "weekend"])
def test_loads_are_never_negative(archetype: str, day: m.DayType) -> None:
    profile = m.unit_profile(archetype, list(m.CAMPAIGN_KEYS), day)
    assert all(v >= 0 for v in profile.baseline)
    assert all(v >= 0 for band in profile.cases.values() for v in band)


@pytest.mark.parametrize("archetype", sorted(m.ARCHETYPES))
def test_stronger_effect_cases_save_at_least_as_much(archetype: str) -> None:
    profile = m.unit_profile(archetype, list(m.CAMPAIGN_KEYS), "weekday")
    saved = {band: sum(profile.baseline) - sum(profile.cases[band]) for band in m.BANDS}
    assert 0 <= saved["low"] <= saved["mid"] <= saved["high"]


@pytest.mark.parametrize("archetype", sorted(m.ARCHETYPES))
def test_adding_a_campaign_never_raises_total_energy(archetype: str) -> None:
    previous = sum(m.unit_profile(archetype, [], "weekday").cases["mid"])
    chosen: list[str] = []
    for key in m.CAMPAIGN_KEYS:
        chosen.append(key)
        energy = sum(m.unit_profile(archetype, chosen, "weekday").cases["mid"])
        assert energy <= previous + 1e-12, f"{key} raised the load of {archetype}"
        previous = energy


def test_no_campaigns_means_no_change() -> None:
    profile = m.unit_profile("hostel", [], "weekday")
    for band in m.BANDS:
        assert profile.cases[band] == profile.baseline


def test_combined_savings_never_exceed_the_sum_of_the_parts() -> None:
    """Campaigns act on the load that is left after the others, so they overlap rather than add."""
    base = sum(m.unit_profile("academic", [], "weekday").baseline)
    each = [base - sum(m.unit_profile("academic", [k], "weekday").cases["mid"]) for k in m.CAMPAIGN_KEYS]
    together = base - sum(m.unit_profile("academic", list(m.CAMPAIGN_KEYS), "weekday").cases["mid"])
    assert together <= sum(each) + 1e-12


def test_a_campaign_only_touches_the_kinds_it_targets() -> None:
    """'Shift the peak' moves geyser use, so it must not change a building with no hot water to shift."""
    chiller = m.unit_profile("chiller", ["shift"], "weekday")
    assert chiller.cases["high"] == chiller.baseline
    hostel = m.unit_profile("hostel", ["shift"], "weekday")
    assert hostel.cases["high"] != hostel.baseline


def test_shifting_the_peak_lowers_the_evening_and_raises_midday() -> None:
    profile = m.unit_profile("hostel", ["shift"], "weekday")
    assert profile.cases["mid"][20] < profile.baseline[20]
    assert profile.cases["mid"][13] > profile.baseline[13]


def test_hostels_peak_in_the_evening_and_academic_blocks_in_working_hours() -> None:
    hostel = m.unit_profile("hostel", [], "weekday").baseline
    academic = m.unit_profile("academic", [], "weekday").baseline
    assert hostel[21] > hostel[13]
    assert 9 <= max(range(24), key=lambda h: academic[h]) <= 17


def test_weekends_differ_from_weekdays() -> None:
    weekday = m.unit_profile("academic", [], "weekday").baseline
    weekend = m.unit_profile("academic", [], "weekend").baseline
    assert sum(weekend) < sum(weekday)


def test_the_model_is_deterministic() -> None:
    assert m.unit_profile("mess", ["ac26", "swap"], "weekend") == m.unit_profile("mess", ["ac26", "swap"], "weekend")


def test_campaign_order_and_repeats_do_not_matter() -> None:
    assert m.unit_profile("lab", ["swap", "ac26", "ac26"], "weekday") == m.unit_profile(
        "lab", ["ac26", "swap"], "weekday"
    )


def test_carbon_intensity_stays_in_its_stated_range() -> None:
    values = [m.carbon_intensity(h) for h in range(24)]
    assert min(values) >= 450 and max(values) <= 900
    assert max(range(24), key=lambda h: values[h]) in range(18, 23)  # the evening peak
    assert min(range(24), key=lambda h: values[h]) in range(10, 16)  # midday, with solar


# ---------------------------------------------------------------- buildings


def test_campaign_mask_matches_the_front_end_bits() -> None:
    assert m.campaign_mask([]) == 0
    assert m.campaign_mask(m.CAMPAIGN_KEYS) == 31
    assert m.campaign_mask(["ac26", "shift"]) == 5
    assert m.campaign_mask(["standby"]) == 8


def test_peak_load_is_intensity_times_area_times_floors() -> None:
    assert m.peak_kw("hostel", 1000.0, 4) == pytest.approx(0.014 * 1000 * 4)
    assert m.peak_kw("hostel", 1000.0, 4, calibration=1.5) == pytest.approx(0.014 * 1000 * 4 * 1.5)


def test_a_chiller_plant_has_a_fixed_load_whatever_its_size() -> None:
    assert m.peak_kw("chiller", 50.0, 1) == m.peak_kw("chiller", 5000.0, 9) == 520


def test_floors_follow_the_front_ends_rule() -> None:
    assert m.default_floors(3.4) == 1
    assert m.default_floors(1.0) == 1  # never below one floor
    assert m.default_floors(30.0) == 9  # 8.8 rounds to 9
    assert m.default_floors(5.1) == 2  # 1.5 rounds half up, as JavaScript does
    assert m.default_floors(8.5) == 3  # 2.5 rounds up too, not to the even number


def test_polygon_area_of_a_rectangle_and_of_a_reversed_one() -> None:
    square = [[0.0, 0.0], [4.0, 0.0], [4.0, 3.0], [0.0, 3.0]]
    assert m.polygon_area(square) == 12.0
    assert m.polygon_area(list(reversed(square))) == 12.0
