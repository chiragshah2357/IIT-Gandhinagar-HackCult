"""The load model: building types, hourly shapes and the five Mission LiFE campaigns.

This is a port of the model in web/app/app.js (the "model library" section and Sim.compute). The two must
agree, and tests/golden/ holds values generated from the JavaScript to prove it. Everything here is a pure
function of its inputs: no I/O, no clock, no randomness.

All of it is modelled. There is no meter data behind any number, and the campaign effect ranges are
placeholders (see docs/data-and-sources.md).
"""

from __future__ import annotations

import math
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from typing import Literal

MODEL_VERSION = "archetype-model-v1"

HOURS = 24
COMPONENTS = ("cool", "light", "plug", "hot")
DayType = Literal["weekday", "weekend"]
Band = Literal["low", "mid", "high"]
BANDS: tuple[Band, ...] = ("low", "mid", "high")


def clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def bell(t: float, centre: float, width: float) -> float:
    """A bump on a 24 hour circle, so a peak near midnight wraps correctly."""
    d = abs(t - centre)
    d = min(d, 24 - d)
    return math.exp(-d * d / (2 * width * width))


def cooling_demand(h: float) -> float:
    return clamp(bell(h, 15, 4) + 0.85 * bell(h, 22, 3), 0, 1)


def carbon_index(h: float) -> float:
    return clamp(0.55 - 0.4 * bell(h, 12.5, 3) + 0.42 * bell(h, 20, 1.8) - 0.12 * bell(h, 3, 2.5), 0, 1)


def carbon_intensity(h: float) -> float:
    """Grid carbon in g CO2 per kWh. An invented hourly shape between 450 and 900, not a published factor."""
    return 450 + 450 * carbon_index(h)


@dataclass(frozen=True)
class WeekendShape:
    k: float
    boost: float
    mid: float


@dataclass(frozen=True)
class Archetype:
    key: str
    label: str
    mix: tuple[float, float, float, float]
    weekend: WeekendShape
    kw_per_m2: float | None = None
    kw_fixed: float | None = None


ARCHETYPES: dict[str, Archetype] = {
    a.key: a
    for a in (
        Archetype("hostel", "Hostel", (0.5, 0.15, 0.22, 0.13), WeekendShape(1, 0.14, 13), kw_per_m2=0.014),
        Archetype("academic", "Academic block", (0.45, 0.25, 0.25, 0.05), WeekendShape(0.3, 0, 13), kw_per_m2=0.02),
        Archetype("library", "Library", (0.4, 0.25, 0.3, 0.05), WeekendShape(0.8, 0, 15), kw_per_m2=0.02),
        Archetype("hall", "Auditorium", (0.45, 0.3, 0.22, 0.03), WeekendShape(0.4, 0, 14), kw_per_m2=0.03),
        Archetype("mess", "Mess", (0.15, 0.15, 0.3, 0.4), WeekendShape(0.95, 0.05, 13), kw_per_m2=0.05),
        Archetype("sports", "Sports complex", (0.4, 0.3, 0.15, 0.15), WeekendShape(1.25, 0.1, 17), kw_per_m2=0.02),
        Archetype("chiller", "Chiller plant", (0.9, 0.04, 0.06, 0), WeekendShape(0.8, 0.05, 15), kw_fixed=520),
        Archetype("residence", "Residence", (0.45, 0.15, 0.27, 0.13), WeekendShape(1.05, 0.1, 13), kw_per_m2=0.012),
        Archetype("lab", "Research lab", (0.3, 0.2, 0.48, 0.02), WeekendShape(0.45, 0, 14), kw_per_m2=0.035),
        Archetype("service", "Services", (0.4, 0.3, 0.25, 0.05), WeekendShape(0.5, 0, 12), kw_per_m2=0.015),
        Archetype("unclassified", "Unclassified", (0.35, 0.3, 0.3, 0.05), WeekendShape(0.6, 0, 12), kw_per_m2=0.008),
    )
}

# Hourly shape of each load component: a base level plus bumps (amplitude, centre hour, width in hours).
Bump = tuple[float, float, float]
ShapeSpec = tuple[float, tuple[Bump, ...]]
SHAPES: dict[str, dict[str, ShapeSpec]] = {
    "hostel": {
        "cool": (0.12, ((0.55, 22, 3.2), (0.25, 15, 3.5))),
        "light": (0.1, ((0.8, 20, 2.2), (0.5, 6.5, 1.2))),
        "plug": (0.3, ((0.45, 21, 3), (0.3, 8, 1.5))),
        "hot": (0.05, ((0.9, 6.5, 1.1), (0.6, 21, 1.4))),
    },
    "academic": {
        "cool": (0.1, ((0.8, 13.5, 3.6),)),
        "light": (0.1, ((0.85, 12.5, 3.4),)),
        "plug": (0.18, ((0.7, 13, 3.6),)),
        "hot": (0.05, ((0.3, 12, 3),)),
    },
    "library": {
        "cool": (0.12, ((0.6, 15, 5),)),
        "light": (0.15, ((0.8, 15, 5),)),
        "plug": (0.2, ((0.7, 16, 5), (0.25, 21, 2))),
        "hot": (0.05, ((0.2, 12, 3),)),
    },
    "hall": {
        "cool": (0.05, ((0.9, 14, 3),)),
        "light": (0.05, ((0.9, 14, 3),)),
        "plug": (0.1, ((0.7, 14, 3),)),
        "hot": (0.02, ((0.2, 13, 3),)),
    },
    "mess": {
        "cool": (0.1, ((0.3, 13, 3),)),
        "light": (0.1, ((0.6, 8, 1.2), (0.8, 13, 1.4), (0.9, 20, 1.4))),
        "plug": (0.15, ((0.7, 8, 1), (0.9, 13.2, 1.2), (0.9, 20.2, 1.3))),
        "hot": (0.1, ((0.8, 7.5, 1.2), (0.9, 12.5, 1.3), (0.9, 19.5, 1.4))),
    },
    "sports": {
        "cool": (0.1, ((0.5, 18, 3),)),
        "light": (0.1, ((0.8, 18, 3),)),
        "plug": (0.12, ((0.4, 18, 3),)),
        "hot": (0.08, ((0.7, 19, 2),)),
    },
    "chiller": {
        "cool": (0.18, ((0.8, 15, 4.5), (0.5, 22, 3.2))),
        "light": (0.3, ()),
        "plug": (0.3, ()),
        "hot": (0, ()),
    },
    "residence": {
        "cool": (0.14, ((0.55, 21.5, 3), (0.2, 14, 3))),
        "light": (0.1, ((0.7, 20, 2.2), (0.4, 7, 1.3))),
        "plug": (0.25, ((0.5, 20.5, 2.6), (0.3, 7, 1.5))),
        "hot": (0.05, ((0.8, 6.8, 1.1), (0.5, 20.5, 1.5))),
    },
    "lab": {
        "cool": (0.2, ((0.6, 14, 4),)),
        "light": (0.2, ((0.7, 13, 4),)),
        "plug": (0.4, ((0.5, 14, 4),)),
        "hot": (0.03, ()),
    },
    "service": {
        "cool": (0.1, ((0.8, 13, 4),)),
        "light": (0.1, ((0.8, 12.5, 4),)),
        "plug": (0.18, ((0.7, 13, 4),)),
        "hot": (0.03, ((0.3, 12, 3),)),
    },
    "unclassified": {
        "cool": (0.1, ((0.7, 13, 4),)),
        "light": (0.1, ((0.8, 12.5, 4),)),
        "plug": (0.15, ((0.6, 13, 4),)),
        "hot": (0.03, ((0.3, 12, 3),)),
    },
}


def component_shape(archetype: str, component: str, h: float) -> float:
    base, bumps = SHAPES[archetype][component]
    v = base + sum(amp * bell(h, centre, width) for amp, centre, width in bumps)
    if component == "cool" and archetype != "chiller":
        v *= 0.6 + 0.4 * cooling_demand(h)
    return clamp(v, 0, 1)


def day_factor(archetype: Archetype, h: float, day: DayType) -> float:
    if day != "weekend":
        return 1.0
    w = archetype.weekend
    return w.k + w.boost * bell(h, w.mid, 4)


# Time profiles that say when in the day a campaign acts.
PROFILES: dict[str, Callable[[float], float]] = {
    "flat": lambda h: 1.0,
    "cool": cooling_demand,
    "away": lambda h: 1 - bell(h, 13, 4),
    "eve": lambda h: bell(h, 20, 2),
    "mid": lambda h: bell(h, 13, 2.5),
    "day": lambda h: bell(h, 13, 3.5),
}

ALL_KINDS: tuple[str, ...] = (
    "hostel",
    "residence",
    "academic",
    "library",
    "hall",
    "sports",
    "lab",
    "chiller",
    "service",
    "unclassified",
)


@dataclass(frozen=True)
class Effect:
    """One cut a campaign makes: which building kinds, which load component, how much, and when."""

    kinds: tuple[str, ...] | Literal["*"]
    component: str
    cut: tuple[float, float, float]  # low, mid and high effect cases
    profile: str
    shift_to: str | None = None

    def applies_to(self, archetype: str) -> bool:
        return self.kinds == "*" or archetype in self.kinds


@dataclass(frozen=True)
class Campaign:
    key: str
    label: str
    note: str
    summary: str
    effects: tuple[Effect, ...]


CAMPAIGNS: tuple[Campaign, ...] = (
    Campaign(
        "ac26",
        "Set it to 26",
        "Raise AC setpoints, and the chilled-water setpoint at the plant.",
        "Cuts cooling by 9-20%.",
        (Effect(ALL_KINDS, "cool", (0.09, 0.15, 0.2), "cool"),),
    ),
    Campaign(
        "away",
        "Lights and fans off",
        "Switch off lights and fans in empty rooms and corridors.",
        "Cuts lighting by 10-25% in teaching buildings and 6-16% in hostels and homes.",
        (
            Effect(("academic", "library", "hall", "lab"), "light", (0.1, 0.18, 0.25), "away"),
            Effect(("hostel", "residence"), "light", (0.06, 0.12, 0.16), "day"),
        ),
    ),
    Campaign(
        "shift",
        "Shift the peak",
        "Run geysers outside the evening carbon peak.",
        "Moves 10-26% of water heating to midday.",
        (Effect(("hostel", "residence", "mess"), "hot", (0.1, 0.18, 0.26), "eve", shift_to="mid"),),
    ),
    Campaign(
        "standby",
        "Standby purge",
        "Switch off idle chargers, TVs and computers.",
        "Cuts plug loads by 3-9%.",
        (Effect("*", "plug", (0.03, 0.06, 0.09), "flat"),),
    ),
    Campaign(
        "swap",
        "Efficient swap",
        "Replace old ACs and fans with star-rated ones. The old units become e-waste.",
        "Cuts cooling by 4-12% and lighting by 4-10%.",
        (
            Effect(ALL_KINDS, "cool", (0.04, 0.08, 0.12), "cool"),
            Effect("*", "light", (0.04, 0.07, 0.1), "flat"),
        ),
    ),
)
CAMPAIGN_KEYS: tuple[str, ...] = tuple(c.key for c in CAMPAIGNS)


def campaign_mask(keys: Iterable[str]) -> int:
    """The bit mask the front end uses: bit i is set when CAMPAIGNS[i] is on."""
    mask = 0
    for key in keys:
        mask |= 1 << CAMPAIGN_KEYS.index(key)
    return mask


# ---------------------------------------------------------------------------
# Profiles per building kind
#
# The model is linear in a building's peak load, so each building kind is computed once as a unit profile
# (peak load 1 kW) and scaled per building. Adding a building does not add any work here.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class UnitProfile:
    """Hourly load of a 1 kW building of one kind: the baseline and the three campaign cases."""

    baseline: tuple[float, ...]
    cases: dict[Band, tuple[float, ...]]


def unit_profile(archetype_key: str, campaigns: Sequence[str], day: DayType) -> UnitProfile:
    archetype = ARCHETYPES[archetype_key]
    # Always applied in the campaigns' own order, as the front end does, so the order a caller lists them in
    # cannot change the floating point result.
    wanted = set(campaigns)
    chosen = [c for c in CAMPAIGNS if c.key in wanted]
    baseline: list[float] = []
    cases: dict[Band, list[float]] = {band: [] for band in BANDS}
    for h in range(HOURS):
        parts = [component_shape(archetype_key, c, h) * archetype.mix[i] for i, c in enumerate(COMPONENTS)]
        wf = day_factor(archetype, h, day)
        baseline.append(sum(parts) * wf)
        for level, band in enumerate(BANDS):
            scaled = list(parts)
            for campaign in chosen:
                for effect in campaign.effects:
                    if not effect.applies_to(archetype_key):
                        continue
                    idx = COMPONENTS.index(effect.component)
                    factor = 1 - effect.cut[level] * PROFILES[effect.profile](h)
                    if effect.shift_to:
                        factor += 0.5 * effect.cut[level] * PROFILES[effect.shift_to](h)
                    scaled[idx] *= factor
            cases[band].append(sum(scaled) * wf)
    return UnitProfile(tuple(baseline), {b: tuple(v) for b, v in cases.items()})


# ---------------------------------------------------------------------------
# Buildings
# ---------------------------------------------------------------------------


def polygon_area(points: Sequence[Sequence[float]]) -> float:
    total = 0.0
    n = len(points)
    for i in range(n):
        x1, z1 = points[i]
        x2, z2 = points[(i + 1) % n]
        total += x1 * z2 - x2 * z1
    return abs(total) / 2


def default_floors(height_m: float) -> int:
    """The front end's rule: one floor per 3.4 m, at least one, rounding halves up like JavaScript."""
    return max(1, math.floor(height_m / 3.4 + 0.5))


def peak_kw(
    archetype_key: str,
    footprint_m2: float,
    floors: int,
    calibration: float = 1.0,
) -> float:
    """Peak load of one building: a fixed figure for plants, otherwise intensity times floor area."""
    archetype = ARCHETYPES[archetype_key]
    base = (
        archetype.kw_fixed if archetype.kw_fixed is not None else (archetype.kw_per_m2 or 0.0) * footprint_m2 * floors
    )
    return base * calibration
