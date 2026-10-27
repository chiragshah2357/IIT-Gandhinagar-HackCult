# Data and sources

What in the prototype is real, what is a placeholder, and where each number came from. If a figure is not in the
"real" column it should not be quoted as a fact about either campus.

## Real versus placeholder

| Item                                | Status                                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------------------- |
| Building positions, IIT Gandhinagar | Real: OpenStreetMap coordinates, read on 22 Oct 2026. Drawn as boxes, not footprints.       |
| Building outlines, Manipal Jaipur   | Real: OpenStreetMap footprints, read on 22 Oct 2026.                                         |
| Building names                      | OpenStreetMap names. MUJ has 83 buildings with no name; they appear as "Unnamed building N". |
| Building heights, floors, uses      | **Placeholder.** Chosen to look plausible. Not surveyed.                                     |
| Building loads and every kW figure  | **Modelled** from archetype profiles. There is no meter data for either campus.              |
| The six "measured" buildings        | **Invented demo flags** to show the measured versus modelled styling. No real meter exists.  |
| IITGN Central Library position      | Inferred from Google Maps labels. OpenStreetMap does not map it.                             |
| IITGN chiller plant, solar carport, substation | **Placeholders** at labelled positions. OpenStreetMap does not map a chiller plant.       |
| MUJ chiller                         | Inferred from the OpenStreetMap feature "Chiller Panel Room".                                |
| MUJ transformer, solar array        | Transformer from OpenStreetMap; solar array position inferred, size **unknown** (200 kWp placeholder). |
| IITGN solar, 499 kWp                | Reported by secondary sources and **not verified** (see below).                              |
| Grid carbon curve                   | **Modelled.** An invented hourly shape between about 450 and 900 g CO2/kWh. It is not anchored to a published factor. |
| Tariff, 7.5 rupees per unit         | **Placeholder.**                                                                             |
| Campaign effect sizes               | **Placeholder ranges** (low, mid, high). They are not read from a source.                    |
| Neighbourhood participation and streaks | **Invented** to demonstrate the ranking and the citizen view.                            |
| System telemetry and outage toggle  | **Simulated** in the page, and labelled as such on screen.                                   |

## Sources

### Positions and outlines

- OpenStreetMap, queried through the Overpass API on 22 October 2026. Data (c) OpenStreetMap contributors, available
  under the [Open Database Licence](https://www.openstreetmap.org/copyright). The seed table in
  `web/app/data/assets.js` is derived from that data, so that file carries the ODbL attribution and its share-alike terms,
  separately from the MIT licence on the code.
- Google Maps, used by eye to read labels (for example the Central Library) where OpenStreetMap has nothing. No Google
  data is stored in this repo.
- IITGN layout as read: the campus lies between the Sabarmati river to the north-west and Diversion Road to the east;
  the academic core is in the north-west, twelve named hostels sit south of it, and "Block 01 to 29" form a chain along
  the east side that looks residential rather than academic. This should be confirmed by someone on campus.
- MUJ layout as read: the AB1 and AB2 teaching complex and the lecture hall complex, B blocks to the west, G blocks to
  the south, faculty apartments further south, utilities on the west edge, a cricket ground to the north. Manipal
  University Road runs along the west side and Vinayak Marg along the east.

### Figures that came from secondary sources (unverified at the source)

| Figure | Where it was reported | Note |
| ------ | --------------------- | ---- |
| IITGN solar about 500 kWp: 190 on academic roofs, 120 on hostel roofs, 190 on a solar carport; roughly 10% of demand | Secondary reports; no primary source was read | An older item says 200 kWp with a plan to reach 500 ([PaGaLGuY](https://www.pagalguy.com/articles/iit-gandhinagar-harnesses-solar-energy-on-its-palaj-campus-3305?amp=1)). They disagree, so treat 499 kWp as a label to check. |
| Academic areas, hostels and chiller plants make up 80 to 90% of IITGN energy use | A three-year consumption and bill case study reported in IITGN's repository; see also the [CSD sustainability pages](https://csd.iitgn.ac.in/?p=4433) | The case study itself has not been read. This is why the model has a chiller archetype. |
| India grid factor 0.727 tCO2/MWh for FY 2023-24 | [SolarQuarter, reporting CEA's CO2 baseline database](https://solarquarter.com/2025/01/06/co2-baseline-database-highlights-indias-progress-in-renewable-energy-and-emission-reduction-cea/) | **Not used by the app.** CEA has since published a later version of its guide. Read the CEA document directly before using any factor. |
| About 6% less AC energy per degree of setpoint | News coverage of the BEE 2018 recommendation | Not read at the BEE source. The "Set it to 26" cut range is a placeholder informed by it. |
| Mission LiFE has 75 individual actions across seven themes (water, energy, waste, e-waste, single-use plastic, food, health) | [MoEFCC LiFE page](https://moef.gov.in/life-cell) and secondary summaries | The five campaigns in the prototype are not yet mapped to the official energy-theme actions. |

No public annual kWh figure was found for IITGN, and none is invented here.

## Models

- **Building load:** archetype hourly shape for each of four components (cooling, lighting, plug, hot water), weighted by
  the archetype's mix, times kW per square metre times floor area times floors, with a weekday or weekend factor.
  Chiller plants use a fixed kW. The archetype table is `ARCH` in `web/app/app.js`.
- **Campaigns:** each campaign cuts one or more components for the building kinds it applies to, by a low, mid and high
  fraction, shaped over the day by a time profile. "Shift the peak" moves part of the cut to midday. The five campaigns
  and their wording are `CAMP` in `web/app/app.js`.
- **Counters:** energy saved so far today, carbon avoided (saved energy times the modelled hourly intensity), bill saved at
  the placeholder tariff, and peak shaved.

## Replacing placeholders with real data

1. Heights, floors and uses: a campus survey, then edit the rows in `web/app/data/assets.js`.
2. Footprints for IITGN: trace or fetch footprints and fill the outline column.
3. Meters: a measured building is a registry row with a meter and readings. Today the flag is a demo; the planned
   ingestion API in [architecture.md](architecture.md) is the real path.
4. Grid factor: take it from the CEA publication and say which year and version.
